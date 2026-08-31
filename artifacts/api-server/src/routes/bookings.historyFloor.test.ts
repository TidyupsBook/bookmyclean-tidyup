/**
 * The bookings list starts at August 1, 2026.
 *
 * Everything scheduled earlier is Jobber-era history: it came in from Jobber
 * during the migration and is looked up there, not here. The floor is the
 * company's *local* midnight, so a July 31 11pm job stays out and an
 * August 1 12:01am job stays in whatever zone the caller's device is in.
 *
 * These tests pin the boundary from both sides in the company's zone, check a
 * cleaner's already-scoped list obeys the same floor, and confirm the floor is
 * a *list* rule only — a direct link to an older job must still resolve, or
 * every deep link and map pin into the archive breaks.
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
      getUserList: async () => ({ data: [] }),
    },
    invitations: {
      createInvitation: async () => ({ id: "inv_test" }),
      revokeInvitation: async () => ({}),
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
  teamMembersTable,
  bookingsTable,
  bookingAssignmentsTable,
  activityTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const runId = `${Date.now()}_${process.pid}`;
const OWNER = `floor_owner_${runId}`;
const CLEANER = `floor_cleaner_${runId}`;

// America/Edmonton is UTC-6 on these dates, so the company's local midnight on
// August 1, 2026 is 2026-08-01T06:00:00Z. Both fixtures sit one minute either
// side of it — and both land on July 31 in UTC, so a server that forgot the
// company timezone would wrongly drop them both.
const COMPANY_TZ = "America/Edmonton";
const JUST_BEFORE = new Date("2026-08-01T05:59:00Z"); // Jul 31, 11:59pm local
const JUST_AFTER = new Date("2026-08-01T06:01:00Z"); // Aug 1, 12:01am local

let server: http.Server;
let baseUrl: string;
let companyId: number;
let beforeCutoffId: number;
let afterCutoffId: number;

async function call(
  method: string,
  path: string,
  as: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { "x-test-user": as },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: OWNER,
      name: `History Floor Co ${runId}`,
      timezone: COMPANY_TZ,
    })
    .returning();
  companyId = company!.id;

  const [seat] = await db
    .insert(teamMembersTable)
    .values({
      companyId,
      name: "Rosa Scrub",
      email: `rosa_${runId}@test.invalid`,
      role: "cleaner",
      status: "active",
      clerkUserId: CLEANER,
    })
    .returning();
  const seatId = seat!.id;

  const rows = await db
    .insert(bookingsTable)
    .values([
      {
        companyId,
        callId: null,
        customerName: "Jobber Era Customer",
        customerPhone: "+15550003333",
        service: "Deep clean",
        scheduledFor: JUST_BEFORE,
        status: "completed",
      },
      {
        companyId,
        callId: null,
        customerName: "Post Cutoff Customer",
        customerPhone: "+15550004444",
        service: "Standard clean",
        scheduledFor: JUST_AFTER,
        status: "confirmed",
      },
    ])
    .returning();
  beforeCutoffId = rows[0]!.id;
  afterCutoffId = rows[1]!.id;

  // The cleaner is on both jobs, so anything missing from their list is the
  // floor talking, not the assignment scoping.
  await db.insert(bookingAssignmentsTable).values([
    { bookingId: beforeCutoffId, teamMemberId: seatId },
    { bookingId: afterCutoffId, teamMemberId: seatId },
  ]);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not determine test server port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server?.close();
  const bookings = await db
    .select({ id: bookingsTable.id })
    .from(bookingsTable)
    .where(eq(bookingsTable.companyId, companyId));
  const bookingIds = bookings.map((b) => b.id);
  if (bookingIds.length > 0) {
    await db
      .delete(bookingAssignmentsTable)
      .where(inArray(bookingAssignmentsTable.bookingId, bookingIds));
  }
  await db.delete(activityTable).where(eq(activityTable.companyId, companyId));
  await db.delete(bookingsTable).where(eq(bookingsTable.companyId, companyId));
  await db
    .delete(teamMembersTable)
    .where(eq(teamMembersTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end();
});

describe("the August 2026 history floor", () => {
  it("drops the job a minute before the company's local cutoff from the owner's list", async () => {
    const list = await call("GET", "/bookings", OWNER);
    expect(list.status).toBe(200);
    const ids = list.body.map((b: any) => b.id);
    expect(ids).toContain(afterCutoffId);
    expect(ids).not.toContain(beforeCutoffId);
  });

  it("applies the same floor to a cleaner's own jobs", async () => {
    const list = await call("GET", "/bookings", CLEANER);
    expect(list.status).toBe(200);
    const ids = list.body.map((b: any) => b.id);
    expect(ids).toEqual([afterCutoffId]);
  });

  it("cannot be dug under with an earlier caller-supplied since", async () => {
    // The optional ?since window narrows the list; it must never widen it.
    const list = await call("GET", "/bookings?since=2000-01-01", OWNER);
    expect(list.status).toBe(200);
    const ids = list.body.map((b: any) => b.id);
    expect(ids).toContain(afterCutoffId);
    expect(ids).not.toContain(beforeCutoffId);
  });

  it("lets a later since narrow the window past the floor", async () => {
    const list = await call("GET", "/bookings?since=2026-08-02", OWNER);
    expect(list.status).toBe(200);
    const ids = list.body.map((b: any) => b.id);
    expect(ids).not.toContain(afterCutoffId);
    expect(ids).not.toContain(beforeCutoffId);
  });

  it("treats until as an inclusive company-local day", async () => {
    // The Aug 1 12:01am job is inside an until=2026-08-01 window…
    const inside = await call("GET", "/bookings?until=2026-08-01", OWNER);
    expect(inside.status).toBe(200);
    expect(inside.body.map((b: any) => b.id)).toContain(afterCutoffId);

    // …and outside an until=2026-07-31 one.
    const outside = await call("GET", "/bookings?until=2026-07-31", OWNER);
    expect(outside.status).toBe(200);
    expect(outside.body.map((b: any) => b.id)).not.toContain(afterCutoffId);
  });

  it("still resolves an older job by direct link", async () => {
    const owner = await call("GET", `/bookings/${beforeCutoffId}`, OWNER);
    expect(owner.status).toBe(200);
    expect(owner.body.customerName).toBe("Jobber Era Customer");

    // A cleaner sent to that job keeps their link too — the floor hides
    // history from the list, it does not revoke access to it.
    const cleaner = await call("GET", `/bookings/${beforeCutoffId}`, CLEANER);
    expect(cleaner.status).toBe(200);
    expect(cleaner.body.id).toBe(beforeCutoffId);
  });
});
