/**
 * POST /calls/:id/save-as-lead — turn a promising phone call into a lead.
 *
 * Pinned behaviors:
 *  1. Owner and dispatcher can create a lead from an unbooked, non-test call.
 *  2. The lead arrives with source="call", hasCalled=true, and the caller's
 *     name/phone pre-filled.
 *  3. Test calls (isTest=true) are rejected with 400.
 *  4. Calls that already have a booking are rejected with 400.
 *  5. A call with no dialable phone is rejected with 400.
 *  6. If any lead already exists with the same E.164 for this company → 409.
 *  7. Saving the same call a second time → 409 (externalId uniqueness).
 *  8. A call belonging to another company returns 404.
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
  bookingsTable,
  teamMembersTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";

const runId = `${Date.now()}_${process.pid}`;
const OWNER = `sal_owner_${runId}`;
const DISPATCHER = `sal_dispatcher_${runId}`;
const CLEANER = `sal_cleaner_${runId}`;
const OTHER_OWNER = `sal_other_owner_${runId}`;

// Run-unique phone digits so concurrent test runs don't collide on the
// shared dev DB.
const seven = String(Date.now() % 10_000_000).padStart(7, "0");
const bump = (n: number) =>
  String((Number(seven) + n * 37) % 10_000_000).padStart(7, "0");

const PLAIN_PHONE = `+1780${bump(0)}`; // unbooked, non-test call
const BOOKED_PHONE = `+1780${bump(1)}`; // call already has a booking
const TEST_PHONE = `+1780${bump(2)}`; // isTest = true
const NO_PHONE_CALL_PHONE = `not-a-number`; // won't normalize to E.164
const EXISTING_LEAD_PHONE = `+1780${bump(4)}`; // lead already exists
const OTHER_CO_PHONE = `+1780${bump(5)}`; // belongs to another company
const DISP_PHONE = `+1780${bump(9)}`; // dispatcher-only call

let server: http.Server;
let baseUrl: string;
let companyId: number;
let otherCompanyId: number;

let plainCallId: number;
let bookedCallId: number;
let testCallId: number;
let noPhoneCallId: number;
let existingLeadCallId: number;
let otherCoCallId: number;
let dispCallId: number;

type JsonResponse = Omit<Response, "json"> & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): Promise<any>;
};

async function asUser(
  userId: string,
  method: string,
  path: string,
): Promise<JsonResponse> {
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { "x-test-user": userId, "content-type": "application/json" },
  });
}

const asOwner = (method: string, path: string) => asUser(OWNER, method, path);
const asDispatcher = (method: string, path: string) =>
  asUser(DISPATCHER, method, path);
const asCleaner = (method: string, path: string) =>
  asUser(CLEANER, method, path);

beforeAll(async () => {
  // Two companies: ours and another's (for scoping checks).
  const companies = await db
    .insert(companiesTable)
    .values([
      {
        ownerUserId: OWNER,
        name: `SaveAsLead Co ${runId}`,
        timezone: "America/Edmonton",
      },
      {
        ownerUserId: OTHER_OWNER,
        name: `SaveAsLead Other ${runId}`,
        timezone: "America/Edmonton",
      },
    ])
    .returning();
  companyId = companies[0]!.id;
  otherCompanyId = companies[1]!.id;

  // Dispatcher and cleaner seats so role-level access can be tested.
  await db.insert(teamMembersTable).values([
    {
      companyId,
      name: "Test Dispatcher",
      role: "dispatcher",
      status: "active",
      clerkUserId: DISPATCHER,
    },
    {
      companyId,
      name: "Test Cleaner",
      role: "cleaner",
      status: "active",
      clerkUserId: CLEANER,
    },
  ]);

  // A booking to attach to bookedCallId.
  const [booking] = await db
    .insert(bookingsTable)
    .values({
      companyId,
      customerName: "Booked Caller",
      customerPhone: BOOKED_PHONE,
      service: "Deep Clean",
      scheduledFor: new Date("2026-09-01T10:00:00Z"),
      status: "pending",
    })
    .returning();

  // Seed all the calls used across the test suite.
  const calls = await db
    .insert(callsTable)
    .values([
      // Happy-path target: unbooked, non-test, dialable phone.
      {
        companyId,
        callerName: "Alice Caller",
        callerPhone: PLAIN_PHONE,
        status: "completed",
        startedAt: new Date("2026-08-18T14:00:00Z"),
      },
      // Already has a booking linked.
      {
        companyId,
        callerName: "Bob Booked",
        callerPhone: BOOKED_PHONE,
        status: "booked",
        startedAt: new Date("2026-08-18T14:05:00Z"),
        bookingId: booking!.id,
      },
      // Owner testing the receptionist — not a customer conversation.
      {
        companyId,
        callerName: "Owner Test",
        callerPhone: TEST_PHONE,
        status: "completed",
        startedAt: new Date("2026-08-18T14:10:00Z"),
        isTest: true,
      },
      // Phone that won't normalize to E.164.
      {
        companyId,
        callerName: "Unknown Caller",
        callerPhone: NO_PHONE_CALL_PHONE,
        status: "completed",
        startedAt: new Date("2026-08-18T14:15:00Z"),
      },
      // Caller who already has a lead in the system.
      {
        companyId,
        callerName: "Eve Existing",
        callerPhone: EXISTING_LEAD_PHONE,
        status: "completed",
        startedAt: new Date("2026-08-18T14:20:00Z"),
      },
      // Belongs to the other company — must not be accessible.
      {
        companyId: otherCompanyId,
        callerName: "Other Co Caller",
        callerPhone: OTHER_CO_PHONE,
        status: "completed",
        startedAt: new Date("2026-08-18T14:25:00Z"),
      },
      // Dispatcher-only call for the dispatcher success test.
      {
        companyId,
        callerName: "Disp Caller",
        callerPhone: DISP_PHONE,
        status: "completed",
        startedAt: new Date("2026-08-18T14:30:00Z"),
      },
    ])
    .returning();

  plainCallId = calls[0]!.id;
  bookedCallId = calls[1]!.id;
  testCallId = calls[2]!.id;
  noPhoneCallId = calls[3]!.id;
  existingLeadCallId = calls[4]!.id;
  otherCoCallId = calls[5]!.id;
  dispCallId = calls[6]!.id;

  // Pre-existing lead for Eve's number — so that call returns 409.
  await db.insert(leadsTable).values({
    companyId,
    externalId: `sal_existing_${runId}`,
    sourceTab: "Test Tab",
    firstName: "Eve",
    lastName: "Existing",
    phoneNumber: EXISTING_LEAD_PHONE,
    phoneE164: EXISTING_LEAD_PHONE,
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db
    .delete(leadsTable)
    .where(inArray(leadsTable.companyId, [companyId, otherCompanyId]));
  await db
    .delete(callsTable)
    .where(inArray(callsTable.companyId, [companyId, otherCompanyId]));
  await db
    .delete(bookingsTable)
    .where(inArray(bookingsTable.companyId, [companyId, otherCompanyId]));
  await db
    .delete(teamMembersTable)
    .where(inArray(teamMembersTable.companyId, [companyId, otherCompanyId]));
  await db
    .delete(companiesTable)
    .where(inArray(companiesTable.id, [companyId, otherCompanyId]));
  await pool.end();
});

describe("POST /calls/:id/save-as-lead — success paths", () => {
  it("owner: creates a lead pre-filled from the call and returns 201", async () => {
    const res = await asOwner("POST", `/calls/${plainCallId}/save-as-lead`);
    expect(res.status).toBe(201);
    const lead = await res.json();
    expect(lead.source).toBe("call");
    expect(lead.sourceTab).toBe("Phone call");
    expect(lead.status).toBe("new");
    expect(lead.firstName).toBe("Alice");
    expect(lead.lastName).toBe("Caller");
    expect(lead.phoneDisplay).toBe(PLAIN_PHONE);
    expect(lead.phoneE164).toBe(PLAIN_PHONE);
    // The lead was just created from this call — it must carry the Called badge.
    expect(lead.hasCalled).toBe(true);
    expect(lead.lastCallAt).not.toBeNull();
  });

  it("dispatcher: also allowed to save a call as a lead", async () => {
    const res = await asDispatcher("POST", `/calls/${dispCallId}/save-as-lead`);
    expect(res.status).toBe(201);
    const lead = await res.json();
    expect(lead.source).toBe("call");
    expect(lead.hasCalled).toBe(true);
  });
});

describe("POST /calls/:id/save-as-lead — rejection paths", () => {
  it("cleaner: 403 — not allowed to access the call log or leads", async () => {
    const res = await asCleaner("POST", `/calls/${plainCallId}/save-as-lead`);
    expect(res.status).toBe(403);
  });

  it("cross-company call: 404 — company scoping prevents access", async () => {
    const res = await asOwner("POST", `/calls/${otherCoCallId}/save-as-lead`);
    expect(res.status).toBe(404);
  });

  it("nonexistent call: 404", async () => {
    const res = await asOwner("POST", `/calls/999999999/save-as-lead`);
    expect(res.status).toBe(404);
  });

  it("test call: 400 — owner testing the receptionist is not a customer", async () => {
    const res = await asOwner("POST", `/calls/${testCallId}/save-as-lead`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/test call/i);
  });

  it("booked call: 400 — the booking is already the conversion", async () => {
    const res = await asOwner("POST", `/calls/${bookedCallId}/save-as-lead`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/booking/i);
  });

  it("no dialable phone: 400 — can't match or text without E.164", async () => {
    const res = await asOwner("POST", `/calls/${noPhoneCallId}/save-as-lead`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/phone/i);
  });

  it("existing lead with same phone: 409 — no duplicate created", async () => {
    const res = await asOwner(
      "POST",
      `/calls/${existingLeadCallId}/save-as-lead`,
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already exists/i);
  });

  it("same call saved twice: 409 on the repeat — idempotent guard", async () => {
    // The owner success test above already created a lead for plainCallId.
    // A second POST for the same call hits the phone dedup check → 409.
    const res = await asOwner("POST", `/calls/${plainCallId}/save-as-lead`);
    expect(res.status).toBe(409);
  });
});
