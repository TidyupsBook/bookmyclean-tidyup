/**
 * Taking a booking by hand while the customer is on the phone.
 *
 * Same live-app-against-real-DB style as the other route tests; Clerk is the
 * only thing mocked. What's under test here is the stuff that only matters
 * when a person is typing fast on a call: the split-out address boxes, the
 * home size, and assigning a cleaner in the same breath as saving the job —
 * including the case where the crew id is wrong, which must not leave a
 * half-saved booking sitting on the schedule.
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
import {
  setGeocoder,
  resetGeocoder,
  clearGeocodeCache,
} from "../services/geocode";

const runId = `${Date.now()}_${process.pid}`;
const OWNER = `intake_owner_${runId}`;

let server: http.Server;
let baseUrl: string;
let companyId: number;
let otherCompanyId: number;
let cleanerSeatId: number;
let offRosterSeatId: number;
let foreignSeatId: number;

type JsonResponse = Omit<Response, "json"> & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): Promise<any>;
};

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<JsonResponse> {
  const headers: Record<string, string> = { "x-test-user": OWNER };
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The smallest body the create route will accept. */
function baseBooking(extra: Record<string, unknown> = {}) {
  return {
    customerName: "Jay Patel",
    customerPhone: "780-920-6391",
    service: "Deep Clean",
    scheduledFor: "2026-09-01T16:00:00.000Z",
    ...extra,
  };
}

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: OWNER,
      name: `Intake Co ${runId}`,
      timezone: "America/Edmonton",
    })
    .returning();
  companyId = company!.id;

  const [other] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `intake_stranger_${runId}`,
      name: `Other Co ${runId}`,
      timezone: "America/Edmonton",
    })
    .returning();
  otherCompanyId = other!.id;

  const seats = await db
    .insert(teamMembersTable)
    .values([
      {
        companyId,
        name: "Cleaner Cass",
        role: "cleaner",
        status: "active",
      },
      {
        companyId,
        name: "Retired Rita",
        role: "cleaner",
        status: "active",
        active: false,
      },
      {
        companyId: otherCompanyId,
        name: "Someone Else",
        role: "cleaner",
        status: "active",
      },
    ])
    .returning();
  cleanerSeatId = seats.find((s) => s.name === "Cleaner Cass")!.id;
  offRosterSeatId = seats.find((s) => s.name === "Retired Rita")!.id;
  foreignSeatId = seats.find((s) => s.name === "Someone Else")!.id;

  clearGeocodeCache();
  setGeocoder(async () => ({ lat: 53.5, lng: -113.5 }));

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  resetGeocoder();
  clearGeocodeCache();
  const companyIds = [companyId, otherCompanyId];
  const bookings = await db
    .select({ id: bookingsTable.id })
    .from(bookingsTable)
    .where(inArray(bookingsTable.companyId, companyIds));
  if (bookings.length > 0) {
    await db.delete(bookingAssignmentsTable).where(
      inArray(
        bookingAssignmentsTable.bookingId,
        bookings.map((b) => b.id),
      ),
    );
  }
  await db
    .delete(bookingsTable)
    .where(inArray(bookingsTable.companyId, companyIds));
  await db
    .delete(activityTable)
    .where(inArray(activityTable.companyId, companyIds));
  await db
    .delete(teamMembersTable)
    .where(inArray(teamMembersTable.companyId, companyIds));
  await db.delete(companiesTable).where(inArray(companiesTable.id, companyIds));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe("taking a booking on the phone", () => {
  it("keeps every answer the caller gave", async () => {
    const res = await call(
      "POST",
      "/bookings",
      baseBooking({
        customerEmail: "jay@example.invalid",
        customerAddress: "5810 Mullen Place",
        addressCity: "Edmonton",
        addressProvince: "AB",
        addressPostal: "T6R 0V4",
        bedrooms: 3,
        bathrooms: 2,
        extras: ["Oven", "Windows"],
        frequency: "biweekly",
        internalNotes: "Key under the mat. Dog in the yard.",
        status: "confirmed",
      }),
    );
    expect(res.status).toBe(201);
    const booking = await res.json();

    expect(booking.customerEmail).toBe("jay@example.invalid");
    expect(booking.customerAddress).toBe("5810 Mullen Place");
    expect(booking.addressCity).toBe("Edmonton");
    expect(booking.addressProvince).toBe("AB");
    expect(booking.addressPostal).toBe("T6R 0V4");
    expect(booking.bedrooms).toBe(3);
    expect(booking.bathrooms).toBe(2);
    expect(booking.extras).toEqual(["Oven", "Windows"]);
    expect(booking.frequency).toBe("biweekly");
    expect(booking.internalNotes).toContain("Key under the mat");
    expect(booking.status).toBe("confirmed");
  });

  it("still saves a booking with none of the extra detail", async () => {
    const res = await call("POST", "/bookings", baseBooking());
    expect(res.status).toBe(201);
    const booking = await res.json();
    // Older bookings and quick entries must come back as nulls, not missing
    // keys — the list endpoint validates its own response.
    expect(booking.addressCity).toBeNull();
    expect(booking.bedrooms).toBeNull();
    expect(booking.extras).toBeNull();
    expect(booking.frequency).toBeNull();
  });

  it("assigns the cleaner in the same step", async () => {
    const res = await call(
      "POST",
      "/bookings",
      baseBooking({ teamMemberIds: [cleanerSeatId] }),
    );
    expect(res.status).toBe(201);
    const booking = await res.json();

    const rows = await db
      .select({ teamMemberId: bookingAssignmentsTable.teamMemberId })
      .from(bookingAssignmentsTable)
      .where(eq(bookingAssignmentsTable.bookingId, booking.id));
    expect(rows.map((r) => r.teamMemberId)).toEqual([cleanerSeatId]);

    // And it shows up on the booking itself, so the dispatcher sees the name
    // without a second request.
    const list = await (await call("GET", "/bookings")).json();
    const saved = list.find((b: { id: number }) => b.id === booking.id);
    expect(saved.crew.map((c: { name: string }) => c.name)).toEqual([
      "Cleaner Cass",
    ]);
  });

  it("refuses someone else's cleaner without saving anything", async () => {
    const before = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.companyId, companyId));

    const res = await call(
      "POST",
      "/bookings",
      baseBooking({ teamMemberIds: [foreignSeatId] }),
    );
    expect(res.status).toBe(400);

    const after = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.companyId, companyId));
    expect(after.length).toBe(before.length);
  });

  it("refuses a cleaner who is off the roster", async () => {
    const res = await call(
      "POST",
      "/bookings",
      baseBooking({ teamMemberIds: [offRosterSeatId] }),
    );
    expect(res.status).toBe(400);
  });
});

describe("filling the form from a call", () => {
  it("reads a typed-out transcript", async () => {
    const res = await call("POST", "/booking-drafts", {
      text: "Hi, it's a 3 bedroom 2 bath at 12 Oak Street, T6R 0V4. I'd like a deep clean.",
    });
    expect(res.status).toBe(200);
    const draft = await res.json();
    expect(draft.customerAddress).toBe("12 Oak Street");
    expect(draft.bedrooms).toBe(3);
    expect(draft.service).toBe("Deep Clean");
    expect(draft.filledFields).toContain("bedrooms");
    expect(draft.callId).toBeNull();
  });

  it("rejects an empty transcript rather than returning a blank form", async () => {
    const res = await call("POST", "/booking-drafts", { text: "" });
    expect(res.status).toBe(400);
  });

  it("404s for a call that isn't this company's", async () => {
    const res = await call("GET", "/calls/999999999/booking-draft");
    expect(res.status).toBe(404);
  });
});
