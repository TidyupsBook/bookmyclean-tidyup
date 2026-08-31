import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { and, eq, isNull, lt } from "drizzle-orm";
import {
  db,
  companiesTable,
  activityTable,
  jobberDeliveriesTable,
} from "@workspace/db";
import { z } from "zod/v4";
import {
  getJobberCredentials,
  getValidAccessToken,
  fetchJobberRequestDetails,
} from "../lib/jobber";
import { importJobberRequestLead } from "../services/jobberRequestLeads";

const router: IRouter = Router();

/** Mount point used by app.ts to scope the raw body parser. */
export const JOBBER_WEBHOOK_PATH = "/api/webhooks/jobber";

/**
 * Topics handled here. Anything else is acknowledged and dropped so Jobber
 * never retries events we don't use.
 *
 * NOTE FOR THE OWNER: webhook topics are switched on in Jobber's *developer
 * app settings* (Developer Center → the app → Webhooks), not per connected
 * account. For requests to reach the Leads inbox, the app must subscribe to
 * the REQUEST_CREATE topic there, pointing at this same webhook URL the
 * APP_DISCONNECT subscription already uses.
 */
const TOPIC_APP_DISCONNECT = "APP_DISCONNECT";
const TOPIC_REQUEST_CREATE = "REQUEST_CREATE";

// Jobber signs each delivery with HMAC-SHA256 over the raw request body using
// the app's client secret, sent base64-encoded in X-Jobber-Hmac-SHA256.
function verifySignature(
  rawBody: Buffer,
  signature: string,
  clientSecret: string,
): boolean {
  const expected = crypto
    .createHmac("sha256", clientSecret)
    .update(rawBody)
    .digest("base64");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * An unfinished claim older than this can be taken over by a retry. Long
 * enough that a concurrent duplicate delivery never re-processes a claim
 * that is merely still working; short enough that a claim stranded by a
 * failed release (or a crashed process) doesn't hold a delivery hostage
 * past Jobber's retry schedule.
 */
const CLAIM_TAKEOVER_AFTER_MS = 2 * 60 * 1000;

/**
 * Release a claim after a processing failure so Jobber's retry gets a clean
 * second attempt. The release itself may fail (the same outage that broke
 * processing can break the delete) — retry a couple of times, and if it
 * still fails, log loudly rather than pretending it worked. The delivery is
 * still not lost: the claim never completed, so once it goes stale the next
 * retry takes it over above.
 */
async function releaseClaim(
  deliveryId: string,
  log: { error: (obj: unknown, msg: string) => void },
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db
        .delete(jobberDeliveriesTable)
        .where(eq(jobberDeliveriesTable.deliveryId, deliveryId));
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  log.error(
    { err: lastErr, deliveryId },
    "Could not release a Jobber delivery claim after a processing failure; " +
      "the unfinished claim will become takeover-eligible for a later retry",
  );
}

const payloadSchema = z.object({
  data: z.object({
    webHookEvent: z.object({
      topic: z.string(),
      accountId: z.string(),
      itemId: z.string().optional(),
      occurredAt: z.string().optional(),
    }),
  }),
});

router.post("/webhooks/jobber", async (req, res): Promise<void> => {
  const creds = getJobberCredentials();
  if (!creds) {
    // Without the client secret we cannot authenticate the sender.
    res.status(503).json({ error: "Jobber credentials not configured" });
    return;
  }

  const rawBody = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(JSON.stringify(req.body ?? {}));
  const signature = req.headers["x-jobber-hmac-sha256"];
  if (
    typeof signature !== "string" ||
    !verifySignature(rawBody, signature, creds.clientSecret)
  ) {
    req.log.warn("Rejected Jobber webhook with missing/invalid signature");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    req.log.warn(
      { errors: parsed.error.message },
      "Unrecognized Jobber payload",
    );
    res.sendStatus(202);
    return;
  }

  const { topic, accountId, itemId, occurredAt } =
    parsed.data.data.webHookEvent;
  if (topic !== TOPIC_APP_DISCONNECT && topic !== TOPIC_REQUEST_CREATE) {
    // Not subscribed to anything else; acknowledge so Jobber stops retrying.
    res.sendStatus(200);
    return;
  }

  const [company] = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.jobberAccountId, accountId));
  if (!company) {
    req.log.warn({ topic, accountId }, "Webhook for unknown Jobber account");
    res.sendStatus(200);
    return;
  }

  if (topic === TOPIC_REQUEST_CREATE) {
    if (!itemId) {
      // Nothing to fetch without the request id; nothing to retry either.
      req.log.warn({ accountId }, "REQUEST_CREATE with no itemId");
      res.sendStatus(200);
      return;
    }

    // Claim the delivery BEFORE doing any work, exactly like the Quo
    // webhook: a replay or Jobber retry of a delivery already handled
    // collides here and is acknowledged without being processed twice.
    // Jobber sends no delivery id, so the identity is built from the event
    // itself — stable across retries, which re-send the same event.
    const deliveryId = `${topic}:${accountId}:${itemId}:${occurredAt ?? ""}`;
    const [claim] = await db
      .insert(jobberDeliveriesTable)
      .values({ deliveryId, topic, companyId: company.id })
      .onConflictDoNothing({ target: jobberDeliveriesTable.deliveryId })
      .returning({ id: jobberDeliveriesTable.id });
    let claimed = Boolean(claim);
    if (!claimed) {
      // Almost always a genuine duplicate — but if the earlier attempt
      // failed AND its claim release failed too, the delivery would be
      // locked out forever behind a claim nobody finished. An unfinished
      // claim past the stale cutoff is therefore up for takeover; the
      // conditional update keeps two concurrent retries from both winning.
      const staleBefore = new Date(Date.now() - CLAIM_TAKEOVER_AFTER_MS);
      const [takeover] = await db
        .update(jobberDeliveriesTable)
        .set({ receivedAt: new Date(), completedAt: null })
        .where(
          and(
            eq(jobberDeliveriesTable.deliveryId, deliveryId),
            isNull(jobberDeliveriesTable.completedAt),
            lt(jobberDeliveriesTable.receivedAt, staleBefore),
          ),
        )
        .returning({ id: jobberDeliveriesTable.id });
      claimed = Boolean(takeover);
      if (claimed) {
        req.log.warn(
          { deliveryId },
          "Took over a stale unfinished Jobber delivery claim",
        );
      }
    }
    if (!claimed) {
      req.log.info({ deliveryId }, "Ignoring duplicate Jobber delivery");
      res.sendStatus(200);
      return;
    }

    try {
      // The event carries only ids — read the request back from Jobber.
      const accessToken = await getValidAccessToken(company);
      const detail = await fetchJobberRequestDetails(accessToken, itemId);
      if (detail) {
        const outcome = await importJobberRequestLead(company, detail);
        req.log.info(
          { companyId: company.id, jobberRequestId: itemId, outcome },
          "Processed Jobber REQUEST_CREATE webhook",
        );
      } else {
        // Deleted between the event and now. Keep the claim; there is
        // nothing a retry could import.
        req.log.info(
          { jobberRequestId: itemId },
          "REQUEST_CREATE for a request Jobber no longer returns",
        );
      }
      // Mark the claim finished so it can never be taken over later.
      await db
        .update(jobberDeliveriesTable)
        .set({ completedAt: new Date() })
        .where(eq(jobberDeliveriesTable.deliveryId, deliveryId));
      res.sendStatus(200);
    } catch (err) {
      // Release the claim so Jobber's retry gets a clean second attempt —
      // holding it while answering 500 would drop the enquiry forever.
      await releaseClaim(deliveryId, req.log);
      req.log.error(
        { err, jobberRequestId: itemId },
        "Jobber REQUEST_CREATE processing failed; claim released for retry",
      );
      res.status(500).json({ error: "Could not process the request event" });
    }
    return;
  }

  await db
    .update(companiesTable)
    .set({
      jobberConnected: false,
      jobberAccessToken: null,
      jobberRefreshToken: null,
      jobberTokenExpiresAt: null,
      jobberOauth: null,
      jobberNeedsReauth: true,
    })
    .where(eq(companiesTable.id, company.id));

  await db.insert(activityTable).values({
    companyId: company.id,
    type: "jobber_synced",
    message: `Jobber account "${company.jobberAccountName ?? accountId}" was disconnected from Jobber's side. Reconnect to keep syncing bookings.`,
  });

  req.log.info(
    { companyId: company.id, accountId },
    "Marked Jobber disconnected after APP_DISCONNECT webhook",
  );
  res.sendStatus(200);
});

export default router;
