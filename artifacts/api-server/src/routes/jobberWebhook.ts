import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db, companiesTable, activityTable } from "@workspace/db";
import { z } from "zod/v4";
import { getJobberCredentials } from "../lib/jobber";

const router: IRouter = Router();

/** Mount point used by app.ts to scope the raw body parser. */
export const JOBBER_WEBHOOK_PATH = "/api/webhooks/jobber";

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

  const { topic, accountId } = parsed.data.data.webHookEvent;
  if (topic !== "APP_DISCONNECT") {
    // Not subscribed to anything else yet; acknowledge so Jobber stops retrying.
    res.sendStatus(200);
    return;
  }

  const [company] = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.jobberAccountId, accountId));
  if (!company) {
    req.log.warn({ accountId }, "APP_DISCONNECT for unknown Jobber account");
    res.sendStatus(200);
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
