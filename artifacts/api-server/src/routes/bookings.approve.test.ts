/**
 * The approve endpoint, and what "Confirmed" is allowed to mean.
 *
 * The service tests cover the Jobber half against a stubbed API; this file is
 * about the promise the Bookings page makes to the owner: a booking cannot be
 * *typed in* as confirmed, only approval can confirm it, and approving is
 * office work a cleaner can't do to their own job.
 *
 * The company here has no Jobber connection on purpose — the local approval
 * has to stand entirely on its own.
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
  jobberQuotesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const runId = `${Date.now()}_${process.pid}`;
const OWNER = `approve_owner_${runId}`;
const CLEANER = `approve_cleaner_${runId}`;

let server: http.Server;
let baseUrl: string;
let companyId: number;
let cleanerSeatId: number;

type JsonResponse = Omit<Response, "json"> & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): Promise<any>;
};

async function call(
  method: string,
  path: string,
  body?: unknown,
  as: string = OWNER,
): Promise<JsonResponse> {
  const headers: Record<string, string> = { "x-test-user": as };
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function makeBooking(over: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(bookingsTable)
    .values({
      companyId,
      customerName: "Dee Dee Lawson",
      customerPhone: "(780) 555-0134",
      service: "Deep clean",
      scheduledFor: new Date("2026-09-10T16:00:00Z"),
      status: "pending",
      ...over,
    })
    .returning();
  return row!;
}

async function reload(id: number) {
  const [row] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.id, id));
  return row!;
}

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: OWNER,
      name: `Approve Co ${runId}`,
      timezone: "America/Edmonton",
    })
    .returning();
  companyId = company!.id;

  // The owner card a real company is created with — it is what "recorded by"
  // credits when the login itself carries no name.
  await db.insert(teamMembersTable).values({
    companyId,
    name: "Pat Owner",
    role: "owner",
    status: "active",
  });

  const [seat] = await db
    .insert(teamMembersTable)
    .values({
      companyId,
      name: "Cleaner Cass",
      role: "cleaner",
      status: "active",
      clerkUserId: CLEANER,
    })
    .returning();
  cleanerSeatId = seat!.id;

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  const bookings = await db
    .select({ id: bookingsTable.id })
    .from(bookingsTable)
    .where(eq(bookingsTable.companyId, companyId));
  if (bookings.length > 0) {
    await db.delete(bookingAssignmentsTable).where(
      inArray(
        bookingAssignmentsTable.bookingId,
        bookings.map((b) => b.id),
      ),
    );
  }
  await db.delete(bookingsTable).where(eq(bookingsTable.companyId, companyId));
  await db.delete(activityTable).where(eq(activityTable.companyId, companyId));
  await db
    .delete(teamMembersTable)
    .where(eq(teamMembersTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe("what confirmed is allowed to mean", () => {
  it("saves a new booking as pending even when the caller asks for confirmed", async () => {
    const res = await call("POST", "/bookings", {
      customerName: "Walk In",
      customerPhone: "780-555-0199",
      service: "Standard clean",
      scheduledFor: "2026-09-11T16:00:00.000Z",
      status: "confirmed",
    });
    expect(res.status).toBe(201);
    expect((await res.json()).status).toBe("pending");
  });

  it("refuses an edit that flips an unapproved booking to confirmed", async () => {
    const booking = await makeBooking();
    const res = await call("PATCH", `/bookings/${booking.id}`, {
      status: "confirmed",
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Approve");
    expect((await reload(booking.id)).status).toBe("pending");
  });

  it("allows confirmed again once the approval is on record — reopening a finished job", async () => {
    const booking = await makeBooking();
    await call("POST", `/bookings/${booking.id}/approve`, { schedule: false });
    await call("PATCH", `/bookings/${booking.id}`, { status: "completed" });

    const res = await call("PATCH", `/bookings/${booking.id}`, {
      status: "confirmed",
    });
    expect(res.status).toBe(200);
    expect((await reload(booking.id)).status).toBe("confirmed");
  });
});

describe("approving from the app", () => {
  it("records who approved, confirms the booking, and says Jobber wasn't involved", async () => {
    const booking = await makeBooking();
    const res = await call("POST", `/bookings/${booking.id}/approve`, {
      schedule: false,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recorded).toBe(true);
    expect(body).not.toHaveProperty("quoteApprovedInJobber");
    expect(body.scheduledInJobber).toBe(false);
    expect(body.booking.status).toBe("confirmed");
    expect(body.booking.clientApprovedAt).toBeTruthy();
    expect(body.booking.clientApprovedBy).toBeTruthy();
  });

  it("says plainly why it can't schedule a booking with no Jobber quote", async () => {
    const booking = await makeBooking({
      status: "confirmed",
      clientApprovedAt: new Date(),
    });
    const res = await call("POST", `/bookings/${booking.id}/approve`, {
      schedule: true,
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("no Jobber quote");
    // The earlier approval remains, but no scheduling side effect occurs.
    expect((await reload(booking.id)).clientApprovedAt).not.toBeNull();
  });

  it("rejects scheduling before approval without recording approval as a side effect", async () => {
    const booking = await makeBooking({ jobberQuoteId: "quo_unapproved" });
    const res = await call("POST", `/bookings/${booking.id}/approve`, {
      schedule: true,
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(
      "Record the client's approval before scheduling",
    );
    const row = await reload(booking.id);
    expect(row.clientApprovedAt).toBeNull();
    expect(row.status).toBe("pending");
  });

  it("keeps Jobber as the approval source when scheduling a mirrored approved quote", async () => {
    const quoteId = `quo_mirrored_${runId}`;
    const booking = await makeBooking({
      jobberQuoteId: quoteId,
      jobberCreatedJobId: `job_existing_${runId}`,
    });
    await db.insert(jobberQuotesTable).values({
      companyId,
      jobberQuoteId: quoteId,
      status: "approved",
    });

    // The company is intentionally disconnected. The real Jobber job id makes
    // this an idempotent replay, so no token or API call should be required.
    const res = await call("POST", `/bookings/${booking.id}/approve`, {
      schedule: true,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recorded).toBe(false);
    expect(body.scheduledInJobber).toBe(true);
    expect(body.booking.jobberQuoteStatus).toBe("approved");
    expect(body.booking.clientApprovedAt).toBeNull();
    expect(body.booking.clientApprovedBy).toBeNull();
    expect(
      await db
        .select()
        .from(activityTable)
        .where(eq(activityTable.bookingId, booking.id)),
    ).toHaveLength(0);
  });

  it("hides stale errors from the removed quoteApprove mutation", async () => {
    const booking = await makeBooking({
      jobberSyncError:
        'Field "quoteApprove" does not exist on type "Mutation".',
      jobberSyncErrorAt: new Date(),
    });

    const res = await call("GET", "/bookings");
    expect(res.status).toBe(200);
    const body = await res.json();
    const listed = body.find((item: { id: number }) => item.id === booking.id);
    expect(listed.jobberSyncError).toBeNull();
    expect(listed.jobberSyncErrorAt).toBeNull();
  });

  it("won't approve a cancelled booking", async () => {
    const booking = await makeBooking({ status: "canceled" });
    const res = await call("POST", `/bookings/${booking.id}/approve`, {
      schedule: false,
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("cancelled");
  });

  it("is not something a cleaner can do to their own job", async () => {
    const booking = await makeBooking();
    await db
      .insert(bookingAssignmentsTable)
      .values({ bookingId: booking.id, teamMemberId: cleanerSeatId });

    const res = await call(
      "POST",
      `/bookings/${booking.id}/approve`,
      { schedule: false },
      CLEANER,
    );

    expect(res.status).toBe(403);
    expect((await reload(booking.id)).clientApprovedAt).toBeNull();
  });

  it("404s for a booking belonging to nobody the caller can see", async () => {
    const res = await call("POST", "/bookings/99999999/approve", {
      schedule: false,
    });
    expect(res.status).toBe(404);
  });
});
