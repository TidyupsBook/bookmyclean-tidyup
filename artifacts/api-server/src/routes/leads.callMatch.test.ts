/**
 * The "they called" badge: a lead whose phone number matches at least one
 * call in the company's call history carries hasCalled + lastCallAt in the
 * lead payload, decided server-side so web and mobile can never disagree.
 *
 * Pinned here:
 *  1. Matching normalizes BOTH sides — a call logged as "780-555-…" still
 *     matches a lead stored as +1780555….
 *  2. lastCallAt is the MOST RECENT matching call, not the first.
 *  3. A lead with no dialable phone is never a match.
 *  4. Another company's calls never light the badge (scoping).
 *  5. Test calls (the owner phoning themselves) don't count.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type http from "node:http";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

vi.mock("@clerk/express", () => ({
  getAuth: (req: { headers: Record<string, unknown> }) => ({
    userId: (req.headers["x-test-user"] as string | undefined) ?? null,
    sessionClaims: {},
  }),
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  clerkClient: {
    users: {
      getUser: async () => ({
        emailAddresses: [],
        firstName: "Test",
        lastName: "User",
      }),
    },
  },
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
  pool,
  companiesTable,
  callsTable,
  leadsTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";

const runId = `${Date.now()}_${process.pid}`;
const OWNER = `leadcall_owner_${runId}`;

// Run-unique last-7 digits so a crashed earlier run can't collide (the test
// DB is shared) — company scoping is what's under test, so the numbers only
// need to be unique across THIS run's fixtures.
const seven = String(Date.now() % 10_000_000).padStart(7, "0");
const bump = (n: number) =>
  String((Number(seven) + n) % 10_000_000).padStart(7, "0");
const CALLED_E164 = `+1587${bump(0)}`;
// The same number as a human would type it — normalization must bridge them.
const CALLED_TYPED = `587-${bump(0).slice(0, 3)}-${bump(0).slice(3)}`;
const OTHER_CO_E164 = `+1587${bump(1)}`;
const TEST_CALL_E164 = `+1587${bump(2)}`;

const OLDER_CALL = new Date("2026-08-10T15:00:00Z");
const NEWER_CALL = new Date("2026-08-16T18:30:00Z");

let server: http.Server;
let baseUrl: string;
let companyId: number;
let otherCompanyId: number;
let calledLeadId: number;
let noPhoneLeadId: number;
let otherMatchLeadId: number;
let testCallLeadId: number;

type JsonResponse = Omit<Response, "json"> & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): Promise<any>;
};

async function call(method: string, path: string): Promise<JsonResponse> {
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { "x-test-user": OWNER },
  });
}

beforeAll(async () => {
  const companies = await db
    .insert(companiesTable)
    .values([
      {
        ownerUserId: OWNER,
        name: `LeadCall Co ${runId}`,
        timezone: "America/Edmonton",
      },
      {
        ownerUserId: `leadcall_other_${runId}`,
        name: `LeadCall Other ${runId}`,
        timezone: "America/Edmonton",
      },
    ])
    .returning();
  companyId = companies[0]!.id;
  otherCompanyId = companies[1]!.id;

  const leads = await db
    .insert(leadsTable)
    .values([
      {
        companyId,
        externalId: `lc_${runId}_called`,
        sourceTab: "Test Tab",
        firstName: "Cathy",
        lastName: "Called",
        phoneNumber: `(587) ${bump(0).slice(0, 3)}-${bump(0).slice(3)}`,
        phoneE164: CALLED_E164,
      },
      {
        companyId,
        externalId: `lc_${runId}_nophone`,
        sourceTab: "Test Tab",
        firstName: "Nora",
        lastName: "NoPhone",
        phoneNumber: null,
        phoneE164: null,
      },
      {
        companyId,
        externalId: `lc_${runId}_othermatch`,
        sourceTab: "Test Tab",
        firstName: "Oscar",
        lastName: "OtherCo",
        phoneNumber: OTHER_CO_E164,
        phoneE164: OTHER_CO_E164,
      },
      {
        companyId,
        externalId: `lc_${runId}_testcall`,
        sourceTab: "Test Tab",
        firstName: "Tess",
        lastName: "TestCall",
        phoneNumber: TEST_CALL_E164,
        phoneE164: TEST_CALL_E164,
      },
    ])
    .returning();
  calledLeadId = leads[0]!.id;
  noPhoneLeadId = leads[1]!.id;
  otherMatchLeadId = leads[2]!.id;
  testCallLeadId = leads[3]!.id;

  await db.insert(callsTable).values([
    // Two real calls from the same person, stored in different formats —
    // the older one as a human typed it, the newer one as the webhook's
    // E.164. lastCallAt must be the NEWER one.
    {
      companyId,
      callerName: "Cathy Called",
      callerPhone: CALLED_TYPED,
      status: "completed",
      startedAt: OLDER_CALL,
    },
    {
      companyId,
      callerName: "Cathy Called",
      callerPhone: CALLED_E164,
      status: "completed",
      startedAt: NEWER_CALL,
    },
    // The other company heard from Oscar's number — must not leak over.
    {
      companyId: otherCompanyId,
      callerName: "Oscar OtherCo",
      callerPhone: OTHER_CO_E164,
      status: "completed",
      startedAt: NEWER_CALL,
    },
    // A test call is the owner trying the receptionist, not a customer.
    {
      companyId,
      callerName: "Tess TestCall",
      callerPhone: TEST_CALL_E164,
      status: "completed",
      startedAt: NEWER_CALL,
      isTest: true,
    },
  ]);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db
    .delete(callsTable)
    .where(inArray(callsTable.companyId, [companyId, otherCompanyId]));
  await db
    .delete(leadsTable)
    .where(inArray(leadsTable.companyId, [companyId, otherCompanyId]));
  await db
    .delete(companiesTable)
    .where(inArray(companiesTable.id, [companyId, otherCompanyId]));
  await pool.end();
});

describe("GET /leads call-match flag", () => {
  it("flags the lead whose number matches calls (normalized both sides) with the most recent call time", async () => {
    const res = await call("GET", "/leads");
    expect(res.status).toBe(200);
    const leads = await res.json();
    const called = leads.find((l: { id: number }) => l.id === calledLeadId);
    expect(called.hasCalled).toBe(true);
    expect(called.lastCallAt).toBe(NEWER_CALL.toISOString());
  });

  it("treats a lead with no dialable phone as no match", async () => {
    const res = await call("GET", "/leads");
    const leads = await res.json();
    const noPhone = leads.find((l: { id: number }) => l.id === noPhoneLeadId);
    expect(noPhone.hasCalled).toBe(false);
    expect(noPhone.lastCallAt).toBeNull();
  });

  it("never matches another company's calls", async () => {
    const res = await call("GET", "/leads");
    const leads = await res.json();
    const other = leads.find((l: { id: number }) => l.id === otherMatchLeadId);
    expect(other.hasCalled).toBe(false);
    expect(other.lastCallAt).toBeNull();
  });

  it("ignores test calls — trying the receptionist is not a customer conversation", async () => {
    const res = await call("GET", "/leads");
    const leads = await res.json();
    const tess = leads.find((l: { id: number }) => l.id === testCallLeadId);
    expect(tess.hasCalled).toBe(false);
    expect(tess.lastCallAt).toBeNull();
  });
});

describe("single-lead responses carry the same flag", () => {
  it("GET /leads/:id matches the list's verdict", async () => {
    const res = await call("GET", `/leads/${calledLeadId}`);
    expect(res.status).toBe(200);
    const lead = await res.json();
    expect(lead.hasCalled).toBe(true);
    expect(lead.lastCallAt).toBe(NEWER_CALL.toISOString());
  });

  it("dismiss keeps the flag intact in its response", async () => {
    const res = await call("POST", `/leads/${calledLeadId}/dismiss`);
    expect(res.status).toBe(200);
    const lead = await res.json();
    expect(lead.status).toBe("dismissed");
    expect(lead.hasCalled).toBe(true);
    expect(lead.lastCallAt).toBe(NEWER_CALL.toISOString());
  });
});
