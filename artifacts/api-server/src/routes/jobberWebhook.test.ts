/**
 * Jobber REQUEST_CREATE webhook tests.
 *
 * A request submitted on Jobber's own form must land in the Leads inbox
 * exactly once: a signed delivery creates one lead, a retried or replayed
 * delivery creates none, a bad signature is rejected outright, and a
 * request this app itself pushed to Jobber never boomerangs back as a
 * lead. Failure handling is pinned too — the delivery claim is released on
 * a processing error so Jobber's retry gets a clean second attempt.
 *
 * The Jobber read-back is stubbed at the lib boundary; the signature check
 * runs for real over the raw body, exactly as app.ts wires it.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import crypto from "node:crypto";
import type http from "node:http";

const TEST_SECRET = "jobber_webhook_test_secret";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
  process.env.JOBBER_CLIENT_ID = "jobber_webhook_test_client";
  process.env.JOBBER_CLIENT_SECRET = "jobber_webhook_test_secret";
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

const detailMock = vi.fn();
vi.mock("../lib/jobber", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/jobber")>();
  return {
    ...actual,
    getValidAccessToken: vi.fn(async () => "test-token"),
    fetchJobberRequestDetails: (...args: unknown[]) => detailMock(...args),
  };
});

import app from "../app";
import {
  db,
  pool,
  companiesTable,
  bookingsTable,
  leadsTable,
  activityTable,
  jobberDeliveriesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type { JobberRequestDetails } from "../lib/jobber";

const runId = `${Date.now()}_${process.pid}`;
const accountId = `jwh_acct_${runId}`;

let server: http.Server;
let baseUrl: string;
let companyId: number;

function detail(
  n: number,
  over: Partial<JobberRequestDetails> = {},
): JobberRequestDetails {
  return {
    id: `jwh_request_${runId}_${n}`,
    title: "Move-out clean",
    requestStatus: "new",
    createdAt: "2026-08-15T10:00:00Z",
    jobberWebUri: `https://secure.getjobber.com/requests/jwh_${n}`,
    contactName: null,
    phone: null,
    email: `jwh${n}_${runId}@example.com`,
    client: {
      id: `jwh_client_${runId}_${n}`,
      firstName: "Jo",
      lastName: `Berman${n}`,
      phone: `+1403555${String(1000 + n).slice(-4)}`,
    },
    property: {
      id: `jwh_prop_${runId}_${n}`,
      address: {
        street: `${n} Jobber Way NW`,
        city: "Calgary",
        province: "AB",
        postalCode: "T2N 1N4",
      },
    },
    notes: {
      nodes: [{ message: "  We have two cats, please text before arriving. " }],
    },
    ...over,
  };
}

function sign(body: string): string {
  return crypto.createHmac("sha256", TEST_SECRET).update(body).digest("base64");
}

function event(itemId: string, occurredAt = "2026-08-15T10:00:05Z") {
  return {
    data: {
      webHookEvent: {
        topic: "REQUEST_CREATE",
        appId: "app_test",
        accountId,
        itemId,
        occurredAt,
      },
    },
  };
}

async function deliver(
  payload: unknown,
  { signature }: { signature?: string } = {},
): Promise<Response> {
  const body = JSON.stringify(payload);
  return fetch(`${baseUrl}/api/webhooks/jobber`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-jobber-hmac-sha256": signature ?? sign(body),
    },
    body,
  });
}

async function leadsFor(requestId: string) {
  return db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.companyId, companyId),
        eq(leadsTable.externalId, requestId),
      ),
    );
}

beforeAll(async () => {
  const [row] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `jwh_owner_${runId}`,
      name: `Jobber Webhook Co ${runId}`,
      timezone: "America/Edmonton",
      jobberConnected: true,
      jobberAccountId: accountId,
      jobberAccessToken: "enc",
      jobberRefreshToken: "enc",
    })
    .returning();
  companyId = row!.id;

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
    .delete(jobberDeliveriesTable)
    .where(eq(jobberDeliveriesTable.companyId, companyId));
  await db.delete(activityTable).where(eq(activityTable.companyId, companyId));
  await db.delete(leadsTable).where(eq(leadsTable.companyId, companyId));
  await db.delete(bookingsTable).where(eq(bookingsTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await pool.end();
});

beforeEach(() => {
  detailMock.mockReset();
});

describe("POST /api/webhooks/jobber REQUEST_CREATE", () => {
  it("creates exactly one lead, verbatim, from a signed delivery", async () => {
    const d = detail(1);
    detailMock.mockResolvedValue(d);

    const res = await deliver(event(d.id));
    expect(res.status).toBe(200);
    expect(detailMock).toHaveBeenCalledWith("test-token", d.id);

    const rows = await leadsFor(d.id);
    expect(rows).toHaveLength(1);
    const lead = rows[0]!;
    expect(lead.source).toBe("jobber");
    expect(lead.status).toBe("new");
    expect(lead.firstName).toBe("Jo");
    expect(lead.lastName).toBe("Berman1");
    expect(lead.phoneNumber).toBe(d.client!.phone);
    expect(lead.phoneE164).toBe(d.client!.phone);
    expect(lead.email).toBe(d.email);
    expect(lead.streetAddress).toBe("1 Jobber Way NW");
    expect(lead.city).toBe("Calgary");
    expect(lead.province).toBe("AB");
    expect(lead.postCode).toBe("T2N 1N4");
    // Title and message are the customer's words, never parsed.
    expect(lead.service).toBe("Move-out clean");
    expect(lead.message).toBe("We have two cats, please text before arriving.");
    expect(lead.createdTime).toBe(d.createdAt);
    // The ids Jobber already has, so converting attaches instead of duplicating.
    expect(lead.jobberRequestId).toBe(d.id);
    expect(lead.jobberClientId).toBe(d.client!.id);
    expect(lead.jobberPropertyId).toBe(d.property!.id);
    expect(lead.jobberWebUri).toBe(d.jobberWebUri);
  });

  it("acknowledges a retried delivery without processing it again", async () => {
    const d = detail(2);
    detailMock.mockResolvedValue(d);

    expect((await deliver(event(d.id))).status).toBe(200);
    expect((await deliver(event(d.id))).status).toBe(200);

    // The claim blocked the second run before any Jobber traffic.
    expect(detailMock).toHaveBeenCalledTimes(1);
    expect(await leadsFor(d.id)).toHaveLength(1);
  });

  it("never turns a replay with a different occurredAt into a second lead", async () => {
    const d = detail(3);
    detailMock.mockResolvedValue(d);

    expect((await deliver(event(d.id, "2026-08-15T10:00:05Z"))).status).toBe(
      200,
    );
    // A replay that isn't byte-identical claims its own delivery row, but
    // the lead's (company, externalId) unique index still collapses it.
    expect((await deliver(event(d.id, "2026-08-15T10:07:31Z"))).status).toBe(
      200,
    );

    expect(await leadsFor(d.id)).toHaveLength(1);
  });

  it("rejects a bad signature without touching anything", async () => {
    const d = detail(4);
    detailMock.mockResolvedValue(d);

    const body = JSON.stringify(event(d.id));
    const res = await fetch(`${baseUrl}/api/webhooks/jobber`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-jobber-hmac-sha256": sign(body + "tampered"),
      },
      body,
    });
    expect(res.status).toBe(401);
    expect(detailMock).not.toHaveBeenCalled();
    expect(await leadsFor(d.id)).toHaveLength(0);
  });

  it("skips a request this app pushed to Jobber itself", async () => {
    const d = detail(5);
    detailMock.mockResolvedValue(d);
    // Our own outbound push recorded the request id it minted.
    await db.insert(bookingsTable).values({
      companyId,
      callId: null,
      customerName: "Pushed Customer",
      customerPhone: "+14035550005",
      service: "Deep clean",
      scheduledFor: new Date(),
      status: "pending",
      jobberSynced: true,
      jobberJobId: d.id,
    });

    expect((await deliver(event(d.id))).status).toBe(200);
    expect(await leadsFor(d.id)).toHaveLength(0);
  });

  it("skips a request already imported as a pending booking", async () => {
    const d = detail(6);
    detailMock.mockResolvedValue(d);
    await db.insert(bookingsTable).values({
      companyId,
      callId: null,
      customerName: "Imported Customer",
      customerPhone: "+14035550006",
      service: "Jobber request",
      scheduledFor: new Date(),
      status: "pending",
      jobberSynced: true,
      jobberSyncedRequestId: d.id,
    });

    expect((await deliver(event(d.id))).status).toBe(200);
    expect(await leadsFor(d.id)).toHaveLength(0);
  });

  it("releases the claim on failure so the retry can succeed", async () => {
    const d = detail(7);
    detailMock.mockRejectedValueOnce(new Error("Jobber is down"));

    const first = await deliver(event(d.id));
    expect(first.status).toBe(500);
    expect(await leadsFor(d.id)).toHaveLength(0);
    // Claim released — the retry is not locked out.
    const claims = await db
      .select()
      .from(jobberDeliveriesTable)
      .where(eq(jobberDeliveriesTable.companyId, companyId));
    expect(claims.some((c) => c.deliveryId.includes(d.id))).toBe(false);

    detailMock.mockResolvedValue(d);
    const retry = await deliver(event(d.id));
    expect(retry.status).toBe(200);
    expect(await leadsFor(d.id)).toHaveLength(1);
  });

  it("takes over a stale unfinished claim so a failed release can't lock a delivery out", async () => {
    const d = detail(9);
    detailMock.mockResolvedValue(d);
    // A previous attempt failed AND its claim release failed too: the row
    // is still there, never completed, and old enough to be stale.
    const occurredAt = "2026-08-15T10:00:05Z";
    const deliveryId = `REQUEST_CREATE:${accountId}:${d.id}:${occurredAt}`;
    await db.insert(jobberDeliveriesTable).values({
      deliveryId,
      topic: "REQUEST_CREATE",
      companyId,
      receivedAt: new Date(Date.now() - 10 * 60_000),
    });

    const res = await deliver(event(d.id, occurredAt));
    expect(res.status).toBe(200);
    expect(detailMock).toHaveBeenCalledTimes(1);
    expect(await leadsFor(d.id)).toHaveLength(1);

    // The takeover finished the claim — a further retry is a duplicate.
    const [row] = await db
      .select()
      .from(jobberDeliveriesTable)
      .where(eq(jobberDeliveriesTable.deliveryId, deliveryId));
    expect(row!.completedAt).not.toBeNull();
  });

  it("treats a fresh unfinished claim as in-flight, not up for grabs", async () => {
    const d = detail(10);
    detailMock.mockResolvedValue(d);
    // Another worker claimed this delivery moments ago and is still on it.
    const occurredAt = "2026-08-15T10:00:05Z";
    await db.insert(jobberDeliveriesTable).values({
      deliveryId: `REQUEST_CREATE:${accountId}:${d.id}:${occurredAt}`,
      topic: "REQUEST_CREATE",
      companyId,
      receivedAt: new Date(),
    });

    const res = await deliver(event(d.id, occurredAt));
    expect(res.status).toBe(200);
    expect(detailMock).not.toHaveBeenCalled();
    expect(await leadsFor(d.id)).toHaveLength(0);
  });

  it("acknowledges an unknown Jobber account without creating anything", async () => {
    const d = detail(8);
    detailMock.mockResolvedValue(d);
    const body = {
      data: {
        webHookEvent: {
          topic: "REQUEST_CREATE",
          accountId: `unknown_${runId}`,
          itemId: d.id,
          occurredAt: "2026-08-15T10:00:05Z",
        },
      },
    };
    expect((await deliver(body)).status).toBe(200);
    expect(detailMock).not.toHaveBeenCalled();
    expect(await leadsFor(d.id)).toHaveLength(0);
  });
});
