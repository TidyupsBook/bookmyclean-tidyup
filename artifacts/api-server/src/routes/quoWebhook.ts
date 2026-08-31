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
import { recordInboundMessage } from "../lib/clientMessaging";
import {
  routeInboundStaffReply,
  findActiveMemberByPhone,
  confirmStaffReply,
} from "../lib/staffChat";
import {
  companyQuoKey,
  isQuoAuthError,
  setQuoNeedsReauth,
} from "../lib/company";

const router: IRouter = Router();

/** Mount point used by app.ts to scope the raw body parser. */
export const QUO_WEBHOOK_PATH = "/api/webhooks/quo";

/**
 * How old a delivery may be and still be processed. Replay protection comes
 * from the delivery-id claim below (a repeated delivery id is acknowledged
 * without being handled), not from this gate — so it only needs to reject
 * absurd clock skew. Quo retries failed deliveries for hours WITH THE
 * ORIGINAL timestamp; a tight window here means any call that lands while
 * the server is asleep, rebooting, or mid-deploy is rejected on every retry
 * and lost forever.
 */
const MAX_AGE_SECONDS = 48 * 60 * 60;

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
 * Quo signs deliveries in one of two ways, depending on which API surface the
 * webhook was registered through:
 *
 * - Legacy (`/v1`, the surface this app registers on): a single
 *   `openphone-signature: hmac;1;<timestamp-ms>;<base64>` header, signing
 *   `{timestamp}.{raw-body}`.
 * - Standard (svix-style, newer API versions): `webhook-id`,
 *   `webhook-timestamp` (unix seconds) and `webhook-signature`
 *   ("v1,<base64>" entries), signing `{id}.{timestamp}.{raw-body}`.
 *
 * Both are HMAC-SHA256 with the base64-decoded signing key (any `whsec_`
 * prefix stripped). Production deliveries carry ONLY the legacy header —
 * this handler originally accepted only the standard trio, and every real
 * delivery was rejected as "missing signature headers". Both schemes stay
 * supported so a Quo-side migration cannot silently kill ingestion again.
 */
type ParsedSignature = {
  scheme: "openphone" | "standard";
  /** Delivery id from the headers, when the scheme provides one. */
  headerDeliveryId: string | null;
  /** The timestamp exactly as signed; units vary by scheme (ms vs s). */
  timestampRaw: string;
  matches: (rawBody: Buffer, signingKey: string) => boolean;
};

function hmacMatches(
  signedContent: string,
  signingKey: string,
  provided: string[],
): boolean {
  const secretBase64 = signingKey.startsWith("whsec_")
    ? signingKey.slice("whsec_".length)
    : signingKey;
  const secretBytes = Buffer.from(secretBase64, "base64");
  const expected = crypto
    .createHmac("sha256", secretBytes)
    .update(signedContent)
    .digest("base64");

  return provided.some((sig) => {
    const left = Buffer.from(sig);
    const right = Buffer.from(expected);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  });
}

function parseSignatureHeaders(
  headers: Record<string, string | string[] | undefined>,
): ParsedSignature | null {
  const legacy = headers["openphone-signature"];
  if (typeof legacy === "string") {
    // `<scheme>;<version>;<timestamp>;<signature>` — tolerate extra trailing
    // fields (a format extension must not repeat the reject-everything
    // failure this file exists to prevent), but never an unknown version.
    const fields = legacy.split(";").map((f) => f.trim());
    const [scheme, version, timestamp, signature] = fields;
    if (scheme !== "hmac" || version !== "1" || !timestamp || !signature) {
      return null;
    }
    return {
      scheme: "openphone",
      headerDeliveryId: null,
      timestampRaw: timestamp,
      matches: (rawBody, signingKey) =>
        hmacMatches(`${timestamp}.${rawBody.toString("utf8")}`, signingKey, [
          signature,
        ]),
    };
  }

  const webhookId = headers["webhook-id"];
  const webhookTimestamp = headers["webhook-timestamp"];
  const webhookSignature = headers["webhook-signature"];
  if (
    typeof webhookId === "string" &&
    typeof webhookTimestamp === "string" &&
    typeof webhookSignature === "string"
  ) {
    const provided = webhookSignature
      .split(" ")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => entry.split(",")[1])
      .filter((sig): sig is string => Boolean(sig));
    return {
      scheme: "standard",
      headerDeliveryId: webhookId,
      timestampRaw: webhookTimestamp,
      matches: (rawBody, signingKey) =>
        hmacMatches(
          `${webhookId}.${webhookTimestamp}.${rawBody.toString("utf8")}`,
          signingKey,
          provided,
        ),
    };
  }

  return null;
}

router.post("/webhooks/quo", async (req, res): Promise<void> => {
  // The raw parser is scoped to `application/json`, so any other content
  // type leaves req.body unset. Reject that before touching the bytes — Quo
  // always sends JSON, and stringifying a non-Buffer here used to throw a
  // 500 before verification ever ran.
  if (!Buffer.isBuffer(req.body)) {
    res.status(400).json({ error: "Expected an application/json body" });
    return;
  }
  const rawBody: Buffer = req.body;

  const signature = parseSignatureHeaders(req.headers);
  if (!signature) {
    // Header names only — values may hold key material.
    req.log.warn(
      { headerNames: Object.keys(req.headers).sort().join(",") },
      "Rejected Quo webhook: missing or malformed signature headers",
    );
    res.status(401).json({ error: "Missing signature headers" });
    return;
  }

  // Legacy timestamps are milliseconds, standard ones seconds; normalize so
  // one age gate covers both (and a sender-side unit change degrades into
  // clock-skew handling instead of rejecting every delivery as stale).
  const rawTimestamp = Number(signature.timestampRaw);
  const timestamp =
    rawTimestamp > 1e12 ? Math.round(rawTimestamp / 1000) : rawTimestamp;
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isFinite(timestamp) ||
    Math.abs(now - timestamp) > MAX_AGE_SECONDS
  ) {
    req.log.warn(
      {
        scheme: signature.scheme,
        timestamp: signature.timestampRaw,
        skewSeconds: now - timestamp,
      },
      "Rejected Quo webhook: stale or invalid timestamp",
    );
    res.status(401).json({ error: "Stale or invalid timestamp" });
    return;
  }

  // Any registered webhook could have signed this; find the one that matches.
  const registered = await db.select().from(quoWebhooksTable);
  const match = registered.find((w) =>
    signature.matches(rawBody, w.signingKey),
  );

  if (!match) {
    req.log.warn(
      {
        scheme: signature.scheme,
        bodyIsBuffer: Buffer.isBuffer(req.body),
        contentType: req.headers["content-type"] ?? null,
        bodyLength: rawBody.length,
        bodySha256: crypto.createHash("sha256").update(rawBody).digest("hex"),
        webhookId: signature.headerDeliveryId,
        keysChecked: registered.length,
      },
      "Rejected Quo webhook with invalid signature",
    );
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

  // The claim identity must be stable ACROSS signing schemes, or one event
  // redelivered under the other scheme (say, mid-migration on Quo's side)
  // would double-process. The payload's own event id is that identity —
  // Quo reuses it on every retry under either scheme. Fall back to the
  // standard scheme's delivery-id header, then to a body hash, so even an
  // id-less payload cannot double-process.
  const deliveryId =
    parsed.data.id ??
    signature.headerDeliveryId ??
    crypto.createHash("sha256").update(rawBody).digest("hex");

  // Recording the delivery id is what makes this idempotent: a replay within
  // the signature window, or Quo's own retry of a delivery we already handled,
  // collides here and is acknowledged without being processed again.
  const [claim] = await db
    .insert(quoDeliveriesTable)
    .values({
      deliveryId,
      eventType: parsed.data.type,
      companyId: match.companyId,
    })
    .onConflictDoNothing({ target: quoDeliveriesTable.deliveryId })
    .returning({ id: quoDeliveriesTable.id });

  if (!claim) {
    req.log.info({ deliveryId }, "Ignoring duplicate Quo delivery");
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
          from?: string;
          text?: string;
          body?: string;
        })
      | undefined;

    // A text, not a call. Only inbound is stored from here — the company's own
    // replies are written when they are sent, and a delivery receipt for one
    // must not echo it back into the thread a second time.
    if (parsed.data.type.startsWith("message.")) {
      const inbound =
        object?.direction === "incoming" &&
        typeof object?.id === "string" &&
        typeof object?.from === "string";
      if (!inbound) {
        res.sendStatus(200);
        return;
      }
      if (
        typeof object.phoneNumberId === "string" &&
        !company.quoNumberIds.includes(object.phoneNumberId)
      ) {
        req.log.warn(
          { phoneNumberId: object.phoneNumberId },
          "Ignoring Quo message for a line this company does not watch",
        );
        res.sendStatus(200);
        return;
      }

      const text = object.text ?? object.body ?? "";
      const body = typeof text === "string" ? text : "";

      // A text from somebody on the roster is a crew reply to a chat
      // notification, not a customer message. Route it back into the thread
      // it was answering; only when no recent thread exists does it fall
      // through to the customer inbox, where it stays visible (labelled as
      // team) rather than vanishing.
      const staffSender = await findActiveMemberByPhone(company, object.from!);
      if (staffSender) {
        const routed = await routeInboundStaffReply(company, staffSender, {
          body,
          quoMessageId: object.id!,
          fromPhone: object.from!,
        });
        if (routed !== "no_conversation") {
          res.sendStatus(200);
          return;
        }
      }

      const recorded = await recordInboundMessage(company, {
        fromPhone: object.from!,
        body,
        quoMessageId: object.id!,
      });
      // A roster member whose text fell through to the customer inbox thinks
      // the crew saw it — tell them to reply in the app instead. Gated on the
      // insert above actually writing a new row (dedupe by Quo message id),
      // so a webhook redelivery cannot send the receipt twice.
      if (staffSender && recorded) {
        await confirmStaffReply(company, object.from!, "no_conversation");
      }
      res.sendStatus(200);
      return;
    }

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
