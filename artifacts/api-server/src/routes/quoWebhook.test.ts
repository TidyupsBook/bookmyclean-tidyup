/**
 * Real Quo deliveries sign with the legacy `openphone-signature` header —
 * `hmac;1;<timestamp-ms>;<base64>` over `{timestamp}.{raw body}` — while
 * newer API versions document the svix-style webhook-id/-timestamp/-signature
 * trio. The handler shipped accepting only the trio, and every production
 * delivery was 401'd as "missing signature headers". These tests pin both
 * schemes, the scheme-independent idempotency claim, and the rejection paths.
 *
 * The fixture company has no Quo API key on purpose: the handler verifies,
 * claims the delivery, then stops at the missing key — so acceptance and
 * idempotency are observable without any outbound Quo API traffic.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import type http from "node:http";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: null, sessionClaims: {} }),
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  clerkClient: { users: { getUser: async () => ({ emailAddresses: [] }) } },
}));

vi.mock("../middlewares/clerkProxyMiddleware", () => ({
  CLERK_PROXY_PATH: "/__clerk",
  clerkProxyMiddleware:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  getClerkProxyHost: () => null,
}));

import app from "../app";
import {
  db,
  companiesTable,
  quoWebhooksTable,
  quoDeliveriesTable,
  pool,
} from "@workspace/db";
import { eq } from "drizzle-orm";

const runId = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const signingKey = crypto.randomBytes(32).toString("base64");
// A second registration whose key is stored with the `whsec_` prefix, the
// way newer Quo API versions return it.
const prefixedKeyBase64 = crypto.randomBytes(32).toString("base64");

let server: http.Server;
let baseUrl: string;
let companyId: number;

beforeAll(async () => {
  const [row] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `quo_wh_owner_${runId}`,
      name: `Quo Webhook Co ${runId}`,
      timezone: "America/Edmonton",
    })
    .returning();
  companyId = row!.id;

  await db.insert(quoWebhooksTable).values([
    {
      companyId,
      quoWebhookId: `WH_test_${runId}`,
      signingKey,
      events: ["call.ringing"],
      url: "https://example.test/api/webhooks/quo",
    },
    {
      companyId,
      quoWebhookId: `WH_prefixed_${runId}`,
      signingKey: `whsec_${prefixedKeyBase64}`,
      events: ["call.ringing"],
      url: "https://example.test/api/webhooks/quo",
    },
  ]);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await db
    .delete(quoDeliveriesTable)
    .where(eq(quoDeliveriesTable.companyId, companyId));
  await db
    .delete(quoWebhooksTable)
    .where(eq(quoWebhooksTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await pool.end();
});

function legacyHeader(
  body: string,
  timestampMs: number,
  keyBase64 = signingKey,
) {
  const digest = crypto
    .createHmac("sha256", Buffer.from(keyBase64, "base64"))
    .update(`${timestampMs}.${body}`)
    .digest("base64");
  return `hmac;1;${timestampMs};${digest}`;
}

function standardHeaders(body: string, id: string, tsSeconds: number) {
  const digest = crypto
    .createHmac("sha256", Buffer.from(signingKey, "base64"))
    .update(`${id}.${tsSeconds}.${body}`)
    .digest("base64");
  return {
    "webhook-id": id,
    "webhook-timestamp": String(tsSeconds),
    "webhook-signature": `v1,${digest}`,
  };
}

async function post(
  body: string,
  headers: Record<string, string>,
  contentType = "application/json",
) {
  return fetch(`${baseUrl}/api/webhooks/quo`, {
    method: "POST",
    headers: { "content-type": contentType, ...headers },
    body,
  });
}

async function claimedIds(): Promise<string[]> {
  const rows = await db
    .select({ deliveryId: quoDeliveriesTable.deliveryId })
    .from(quoDeliveriesTable)
    .where(eq(quoDeliveriesTable.companyId, companyId));
  return rows.map((r) => r.deliveryId);
}

describe("POST /api/webhooks/quo signature schemes", () => {
  it("accepts a legacy openphone-signature delivery and claims it by event id", async () => {
    const eventId = `EV_legacy_${runId}`;
    const body = JSON.stringify({
      id: eventId,
      type: "call.ringing",
      data: { object: { id: `AC_${runId}` } },
    });
    const res = await post(body, {
      "openphone-signature": legacyHeader(body, Date.now()),
    });
    expect(res.status).toBe(200);
    expect(await claimedIds()).toContain(eventId);
  });

  it("acknowledges a retry of the same event without processing it twice", async () => {
    const eventId = `EV_retry_${runId}`;
    const body = JSON.stringify({
      id: eventId,
      type: "call.ringing",
      data: { object: { id: `AC2_${runId}` } },
    });
    // Quo retries with the ORIGINAL signature and timestamp.
    const header = { "openphone-signature": legacyHeader(body, Date.now()) };

    expect((await post(body, header)).status).toBe(200);
    expect((await post(body, header)).status).toBe(200);

    const ids = (await claimedIds()).filter((id) => id === eventId);
    expect(ids).toHaveLength(1);
  });

  it("claims one event only once even when redelivered under the other scheme", async () => {
    const eventId = `EV_cross_${runId}`;
    const body = JSON.stringify({
      id: eventId,
      type: "call.ringing",
      data: { object: { id: `AC4_${runId}` } },
    });

    const legacy = await post(body, {
      "openphone-signature": legacyHeader(body, Date.now()),
    });
    const standard = await post(
      body,
      standardHeaders(body, `wh_cross_${runId}`, Math.floor(Date.now() / 1000)),
    );

    expect(legacy.status).toBe(200);
    expect(standard.status).toBe(200);
    const ids = await claimedIds();
    expect(ids.filter((id) => id === eventId)).toHaveLength(1);
    // The event id is the canonical claim key; the trio's delivery id is
    // only a fallback for id-less payloads.
    expect(ids).not.toContain(`wh_cross_${runId}`);
  });

  it("accepts a signing key stored with the whsec_ prefix", async () => {
    const eventId = `EV_whsec_${runId}`;
    const body = JSON.stringify({
      id: eventId,
      type: "call.ringing",
      data: { object: { id: `AC5_${runId}` } },
    });
    const res = await post(body, {
      "openphone-signature": legacyHeader(body, Date.now(), prefixedKeyBase64),
    });
    expect(res.status).toBe(200);
    expect(await claimedIds()).toContain(eventId);
  });

  it("rejects a legacy-signed delivery whose body was tampered with", async () => {
    const body = JSON.stringify({
      id: `EV_tamper_${runId}`,
      type: "call.ringing",
    });
    const header = legacyHeader(body, Date.now());
    const res = await post(body.replace("call.ringing", "call.completed"), {
      "openphone-signature": header,
    });
    expect(res.status).toBe(401);
  });

  it("rejects an unknown legacy signature version outright", async () => {
    const body = JSON.stringify({
      id: `EV_badver_${runId}`,
      type: "call.ringing",
    });
    const header = legacyHeader(body, Date.now()).replace("hmac;1;", "hmac;9;");
    const res = await post(body, { "openphone-signature": header });
    expect(res.status).toBe(401);
  });

  it("rejects a legacy delivery older than the retry window", async () => {
    const body = JSON.stringify({
      id: `EV_stale_${runId}`,
      type: "call.ringing",
    });
    const threeDaysAgoMs = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const res = await post(body, {
      "openphone-signature": legacyHeader(body, threeDaysAgoMs),
    });
    expect(res.status).toBe(401);
    expect(await claimedIds()).not.toContain(`EV_stale_${runId}`);
  });

  it("still accepts the documented standard trio, claiming by event id", async () => {
    const deliveryId = `wh_std_${runId}`;
    const eventId = `EV_std_${runId}`;
    const body = JSON.stringify({
      id: eventId,
      type: "call.ringing",
      data: { object: { id: `AC3_${runId}` } },
    });
    const res = await post(
      body,
      standardHeaders(body, deliveryId, Math.floor(Date.now() / 1000)),
    );
    expect(res.status).toBe(200);
    expect(await claimedIds()).toContain(eventId);
  });

  it("rejects a request with no signature headers at all", async () => {
    const res = await post(JSON.stringify({ type: "call.ringing" }), {});
    expect(res.status).toBe(401);
  });

  it("rejects a non-JSON content type cleanly instead of crashing", async () => {
    const body = "not json at all";
    const res = await post(
      body,
      { "openphone-signature": legacyHeader(body, Date.now()) },
      "text/plain",
    );
    expect(res.status).toBe(400);
  });
});
