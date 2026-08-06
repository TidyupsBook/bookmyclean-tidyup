import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  companiesTable,
  quoWebhooksTable,
  quoDeliveriesTable,
} from "@workspace/db";
import { z } from "zod/v4";
import * as quo from "../lib/quo";
import { upsertCall, applyTranscript } from "../lib/quoIngest";
import {
  companyQuoKey,
  isQuoAuthError,
  setQuoNeedsReauth,
} from "../lib/company";

const router: IRouter = Router();

/** Mount point used by app.ts to scope the raw body parser. */
export const QUO_WEBHOOK_PATH = "/api/webhooks/quo";

const MAX_AGE_SECONDS = 5 * 60;

const eventSchema = z.object({
  id: z.string().optional(),
  type: z.string(),
  data: z
    .object({
      object: z.looseObject({}).optional(),
    })
    .optional(),
});

/**
 * Quo signs each delivery with HMAC-SHA256 over
 * `{webhook-id}.{webhook-timestamp}.{raw-body}` using the base64-decoded
 * portion of the `whsec_...` signing key.
 */
function verifySignature(
  rawBody: Buffer,
  webhookId: string,
  webhookTimestamp: string,
  webhookSignature: string,
  signingKey: string,
): boolean {
  const secretBase64 = signingKey.startsWith("whsec_")
    ? signingKey.slice("whsec_".length)
    : signingKey;
  const secretBytes = Buffer.from(secretBase64, "base64");

  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody.toString("utf8")}`;
  const expected = crypto
    .createHmac("sha256", secretBytes)
    .update(signedContent)
    .digest("base64");

  return webhookSignature
    .split(" ")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split(",")[1])
    .filter((sig): sig is string => Boolean(sig))
    .some((sig) => {
      const left = Buffer.from(sig);
      const right = Buffer.from(expected);
      return (
        left.length === right.length && crypto.timingSafeEqual(left, right)
      );
    });
}

router.post("/webhooks/quo", async (req, res): Promise<void> => {
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(JSON.stringify(req.body));

  const webhookId = req.headers["webhook-id"];
  const webhookTimestamp = req.headers["webhook-timestamp"];
  const webhookSignature = req.headers["webhook-signature"];

  if (
    typeof webhookId !== "string" ||
    typeof webhookTimestamp !== "string" ||
    typeof webhookSignature !== "string"
  ) {
    res.status(401).json({ error: "Missing signature headers" });
    return;
  }

  const timestamp = Number(webhookTimestamp);
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isFinite(timestamp) ||
    Math.abs(now - timestamp) > MAX_AGE_SECONDS
  ) {
    res.status(401).json({ error: "Stale or invalid timestamp" });
    return;
  }

  // Any registered webhook could have signed this; find the one that matches.
  const registered = await db.select().from(quoWebhooksTable);
  const match = registered.find((w) =>
    verifySignature(
      rawBody,
      webhookId,
      webhookTimestamp,
      webhookSignature,
      w.signingKey,
    ),
  );

  if (!match) {
    req.log.warn("Rejected Quo webhook with invalid signature");
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

  const parsed = eventSchema.safeParse(payload);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Unrecognized Quo payload");
    res.sendStatus(202);
    return;
  }

  // Recording the delivery id is what makes this idempotent: a replay within
  // the signature window, or Quo's own retry of a delivery we already handled,
  // collides here and is acknowledged without being processed again.
  const [claim] = await db
    .insert(quoDeliveriesTable)
    .values({
      deliveryId: webhookId,
      eventType: parsed.data.type,
      companyId: match.companyId,
    })
    .onConflictDoNothing({ target: quoDeliveriesTable.deliveryId })
    .returning({ id: quoDeliveriesTable.id });

  if (!claim) {
    req.log.info({ webhookId }, "Ignoring duplicate Quo delivery");
    res.sendStatus(200);
    return;
  }

  const [company] = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.id, match.companyId));
  if (!company) {
    res.sendStatus(200);
    return;
  }

  const apiKey = companyQuoKey(company);
  if (!apiKey) {
    req.log.warn(
      { companyId: company.id },
      "Quo event for a company with no usable API key; asking for reconnect",
    );
    res.sendStatus(200);
    return;
  }

  try {
    const object = parsed.data.data?.object as
      | (Record<string, unknown> & {
          id?: string;
          callId?: string;
          phoneNumberId?: string;
          direction?: string;
        })
      | undefined;
    const callId = object?.callId ?? object?.id;
    if (typeof callId !== "string") {
      res.sendStatus(200);
      return;
    }

    const numbers = await quo.listPhoneNumbers(apiKey);
    const ourNumbers = new Set(numbers.map((n) => n.number));

    // Only ingest calls on lines this company actually claimed, so a webhook
    // can never pull another tenant's traffic into this dashboard.
    const call =
      object?.direction && object?.phoneNumberId
        ? (object as unknown as quo.QuoCall)
        : await quo.getCall(apiKey, callId);
    if (!call) {
      res.sendStatus(200);
      return;
    }
    if (!company.quoNumberIds.includes(call.phoneNumberId)) {
      req.log.warn(
        { callId, phoneNumberId: call.phoneNumberId },
        "Ignoring Quo event for a line this company does not watch",
      );
      res.sendStatus(200);
      return;
    }

    await upsertCall(company, call, ourNumbers);

    if (
      parsed.data.type === "call.transcript.completed" ||
      parsed.data.type === "call.summary.completed"
    ) {
      await applyTranscript(apiKey, company, callId, ourNumbers);
    }

    res.sendStatus(200);
  } catch (err) {
    // A 401/403 means the company's key was revoked or rotated — record it so
    // the dashboard warns the owner that calls have stopped flowing.
    if (isQuoAuthError(err)) {
      await setQuoNeedsReauth(company, true).catch(() => {});
    }
    // Release the idempotency claim so Quo's retry is processed rather than
    // silently swallowed as a duplicate, then fail loudly enough to trigger it.
    await db
      .delete(quoDeliveriesTable)
      .where(eq(quoDeliveriesTable.id, claim.id));

    req.log.error(
      { err: (err as Error).message, type: parsed.data.type },
      "Failed to process Quo webhook; asking Quo to retry",
    );
    res.status(500).json({ error: "Processing failed" });
  }
});

export default router;
