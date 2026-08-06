/**
 * The on-site clock, end to end.
 *
 * What matters here is what happens on a phone in a driveway: a cleaner taps
 * Start, maybe taps it twice because the signal is poor, works, taps Stop.
 * The customer must never be billed for two overlapping stretches, a cleaner
 * must not be able to clock a job they were not sent to, and stopping a clock
 * that was never running has to say so rather than inventing a zero-minute
 * visit.
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
  bookingTimeEntriesTable,
  activityTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const runId = `${Date.now()}_${process.pid}`;
const OWNER = `timer_owner_${runId}`;
const CLEANER = `timer_cleaner_${runId}`;
const OTHER_CLEANER = `timer_other_cleaner_${runId}`;

let server: http.Server;
let baseUrl: string;
let companyId: number;
let assignedBookingId: number;
let unassignedBookingId: number;

async function call(
  method: string,
  path: string,
  as: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      "x-test-user": as,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: OWNER,
      name: `Timer Test Co ${runId}`,
      timezone: "America/Edmonton",
    })
    .returning();
  companyId = company!.id;

  const seats = await db
    .insert(teamMembersTable)
    .values([
      {
        companyId,
        name: "Maria Clean",
        email: `maria_${runId}@test.invalid`,
        role: "cleaner",
        status: "active",
        clerkUserId: CLEANER,
      },
      {
        companyId,
        name: "Sam Elsewhere",
        email: `sam_${runId}@test.invalid`,
        role: "cleaner",
        status: "active",
        clerkUserId: OTHER_CLEANER,
      },
    ])
    .returning();
  const mariaSeatId = seats[0]!.id;

  const bookings = await db
    .insert(bookingsTable)
    .values([
      {
        companyId,
        callId: null,
        customerName: "Clocked Customer",
        customerPhone: "+15550001111",
        service: "Deep clean",
        scheduledFor: new Date("2030-03-01T17:00:00Z"),
        status: "confirmed",
      },
      {
        companyId,
        callId: null,
        customerName: "Someone Else's Job",
        customerPhone: "+15550002222",
        service: "Standard clean",
        scheduledFor: new Date("2030-03-02T17:00:00Z"),
        status: "confirmed",
      },
    ])
    .returning();
  assignedBookingId = bookings[0]!.id;
  unassignedBookingId = bookings[1]!.id;

  await db.insert(bookingAssignmentsTable).values({
    bookingId: assignedBookingId,
    teamMemberId: mariaSeatId,
  });

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
      .delete(bookingTimeEntriesTable)
      .where(inArray(bookingTimeEntriesTable.bookingId, bookingIds));
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

describe("the on-site clock", () => {
  it("starts running when the cleaner on the job taps Start", async () => {
    const started = await call(
      "POST",
      `/bookings/${assignedBookingId}/timer/start`,
      CLEANER,
    );
    expect(started.status).toBe(200);
    expect(started.body.timerRunningSince).toBeTruthy();
    expect(started.body.workedMinutes).toBe(0);
  });

  it("opens only one clock however many times Start is tapped", async () => {
    const again = await call(
      "POST",
      `/bookings/${assignedBookingId}/timer/start`,
      CLEANER,
    );
    expect(again.status).toBe(200);

    const rows = await db
      .select()
      .from(bookingTimeEntriesTable)
      .where(eq(bookingTimeEntriesTable.bookingId, assignedBookingId));
    expect(rows.filter((r) => r.endedAt === null)).toHaveLength(1);
  });

  it("banks the time when the job is stopped", async () => {
    const stopped = await call(
      "POST",
      `/bookings/${assignedBookingId}/timer/stop`,
      CLEANER,
    );
    expect(stopped.status).toBe(200);
    expect(stopped.body.timerRunningSince).toBeNull();
    expect(stopped.body.timeEntries).toHaveLength(1);
    expect(stopped.body.timeEntries[0].endedAt).toBeTruthy();
    // A stretch of a few milliseconds rounds to nothing, which is the honest
    // answer — what matters is that the stretch is closed and listed.
    expect(stopped.body.workedMinutes).toBe(0);
  });

  it("says so instead of inventing a visit when nothing was running", async () => {
    const stopped = await call(
      "POST",
      `/bookings/${assignedBookingId}/timer/stop`,
      CLEANER,
    );
    expect(stopped.status).toBe(409);
  });

  it("records who clocked on, by name", async () => {
    const [entry] = await db
      .select()
      .from(bookingTimeEntriesTable)
      .where(eq(bookingTimeEntriesTable.bookingId, assignedBookingId));
    expect(entry!.startedByName).toBe("Maria Clean");
    expect(entry!.companyId).toBe(companyId);
  });

  it("writes the start and finish into the activity feed", async () => {
    const rows = await db
      .select()
      .from(activityTable)
      .where(eq(activityTable.companyId, companyId));
    const types = rows.map((r) => r.type);
    expect(types).toContain("job_started");
    expect(types).toContain("job_finished");
  });

  it("will not let a cleaner clock a job they were not sent to", async () => {
    const started = await call(
      "POST",
      `/bookings/${unassignedBookingId}/timer/start`,
      OTHER_CLEANER,
    );
    expect(started.status).toBe(404);

    const rows = await db
      .select()
      .from(bookingTimeEntriesTable)
      .where(eq(bookingTimeEntriesTable.bookingId, unassignedBookingId));
    expect(rows).toHaveLength(0);
  });

  it("lets the office clock a job on the crew's behalf", async () => {
    const started = await call(
      "POST",
      `/bookings/${unassignedBookingId}/timer/start`,
      OWNER,
    );
    expect(started.status).toBe(200);
    expect(started.body.timerRunningSince).toBeTruthy();

    const stopped = await call(
      "POST",
      `/bookings/${unassignedBookingId}/timer/stop`,
      OWNER,
    );
    expect(stopped.status).toBe(200);
  });

  it("keeps money out of the crew's copy of the clocked job", async () => {
    await db
      .update(bookingsTable)
      .set({ quoteHours: 3, quoteHourlyRate: 60 })
      .where(eq(bookingsTable.id, assignedBookingId));

    const started = await call(
      "POST",
      `/bookings/${assignedBookingId}/timer/start`,
      CLEANER,
    );
    expect(started.status).toBe(200);
    expect(started.body.quoteHours).toBeNull();
    expect(started.body.quoteTotals).toBeNull();

    await call("POST", `/bookings/${assignedBookingId}/timer/stop`, CLEANER);
  });

  it("shows the clocked time on the bookings list, not just the timer routes", async () => {
    const list = await call("GET", "/bookings", OWNER);
    const booking = list.body.find((b: any) => b.id === assignedBookingId);
    expect(booking.timeEntries.length).toBeGreaterThanOrEqual(2);
    expect(booking.timerRunningSince).toBeNull();
  });
});
