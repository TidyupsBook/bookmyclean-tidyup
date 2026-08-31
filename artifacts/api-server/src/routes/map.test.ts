/**
 * Live-map + scheduling integration tests.
 *
 * Same live-app-against-real-DB style as authorization.test.ts: Clerk is the
 * only thing mocked (caller id via x-test-user). Two companies are seeded so
 * cross-company isolation is provable, plus a cleaner whose scoped views are
 * asserted directly.
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
  teamMembersTable,
  bookingsTable,
  bookingAssignmentsTable,
  cleanerLocationsTable,
  homeownerPinsTable,
  savedRouteStopsTable,
  savedRoutesTable,
  servicesTable,
  activityTable,
  callsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  setGeocoder,
  resetGeocoder,
  clearGeocodeCache,
} from "../services/geocode";
import {
  clearDirectionsCache,
  resetDirectionsProvider,
  setDirectionsProvider,
} from "../services/directions";

type Role = "owner" | "dispatcher" | "cleaner";

const runId = `${Date.now()}_${process.pid}`;
const USERS: Record<string, string> = {
  ownerA: `map_ownerA_${runId}`,
  dispatcherA: `map_dispatcherA_${runId}`,
  cleanerA: `map_cleanerA_${runId}`,
  cleanerA2: `map_cleanerA2_${runId}`,
  ownerB: `map_ownerB_${runId}`,
  cleanerB: `map_cleanerB_${runId}`,
};

let server: http.Server;
let baseUrl: string;

let companyAId: number;
let companyBId: number;
let ownerASeatId: number;
let cleanerASeatId: number;
let cleanerA2SeatId: number;
let cleanerBSeatId: number;
// Two jobs on the target day for company A, one geocoded, one not.
let jobAssignedId: number;
let jobUnassignedId: number;
let jobOtherDayId: number;
let jobCompanyBId: number;
let jobPendingLocatedId: number;

const DAY = "2030-05-15";

async function call(
  method: string,
  path: string,
  opts: { as?: keyof typeof USERS | null; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.as) headers["x-test-user"] = USERS[opts.as]!;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  return fetch(`${baseUrl}/api${path}`, { method, headers, body });
}

beforeAll(async () => {
  // Company A schedules in Toronto so day boundaries are provably in the
  // company zone, not the server's.
  const [companyA] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: USERS.ownerA,
      name: `Map Co A ${runId}`,
      timezone: "America/Toronto",
    })
    .returning();
  const [companyB] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: USERS.ownerB,
      name: `Map Co B ${runId}`,
      timezone: "America/Toronto",
    })
    .returning();
  companyAId = companyA!.id;
  companyBId = companyB!.id;

  const seats = await db
    .insert(teamMembersTable)
    .values([
      // The owner-role roster row a real company gets at creation. Deliberately
      // only for company A: company B's owner has none, which proves the
      // no-seat rejection below.
      {
        companyId: companyAId,
        name: "You",
        email: `ownerA_${runId}@test.invalid`,
        role: "owner",
        status: "active",
      },
      {
        companyId: companyAId,
        name: "Dispatcher A",
        email: `disp_${runId}@test.invalid`,
        role: "dispatcher",
        status: "active",
        clerkUserId: USERS.dispatcherA,
      },
      {
        companyId: companyAId,
        name: "Cleaner A One",
        email: `cleanerA_${runId}@test.invalid`,
        role: "cleaner",
        // Tracking is opt-in per person now; this crew is switched on.
        locationSharing: true,
        status: "active",
        clerkUserId: USERS.cleanerA,
      },
      {
        companyId: companyAId,
        name: "Cleaner A Two",
        email: `cleanerA2_${runId}@test.invalid`,
        role: "cleaner",
        // Tracking is opt-in per person now; this crew is switched on.
        locationSharing: true,
        status: "active",
        clerkUserId: USERS.cleanerA2,
      },
      {
        companyId: companyBId,
        name: "Cleaner B",
        email: `cleanerB_${runId}@test.invalid`,
        role: "cleaner",
        // Tracking is opt-in per person now; this crew is switched on.
        locationSharing: true,
        status: "active",
        clerkUserId: USERS.cleanerB,
      },
    ])
    .returning();
  ownerASeatId = seats.find((s) => s.role === "owner")!.id;
  cleanerASeatId = seats.find((s) => s.clerkUserId === USERS.cleanerA)!.id;
  cleanerA2SeatId = seats.find((s) => s.clerkUserId === USERS.cleanerA2)!.id;
  cleanerBSeatId = seats.find((s) => s.clerkUserId === USERS.cleanerB)!.id;

  await db.insert(servicesTable).values({
    companyId: companyAId,
    name: "Deep clean",
    durationMinutes: 180,
  });

  const bookings = await db
    .insert(bookingsTable)
    .values([
      {
        companyId: companyAId,
        callId: null,
        customerName: "Assigned Customer",
        customerPhone: "+15550000001",
        customerAddress: "1 Assigned St",
        service: "Deep clean",
        // Noon Toronto on the target day.
        scheduledFor: new Date("2030-05-15T16:00:00Z"),
        status: "confirmed",
        quotedAmount: 250,
        lat: 43.65,
        lng: -79.38,
        geocodedAt: new Date("2030-05-14T00:00:00Z"),
      },
      {
        companyId: companyAId,
        callId: null,
        customerName: "Unassigned Customer",
        customerPhone: "+15550000002",
        customerAddress: "2 Unassigned Ave",
        // No matching service row, so schedule falls back to 120.
        service: "Mystery clean",
        scheduledFor: new Date("2030-05-15T20:00:00Z"),
        status: "pending",
        // Deliberately NOT geocoded — proves map/data omits pinless jobs.
      },
      {
        companyId: companyAId,
        callId: null,
        customerName: "Other Day Customer",
        customerPhone: "+15550000003",
        // Intentionally not in the service list so the calendar keeps its
        // two-hour fallback coverage on a confirmed booking.
        service: "Mystery clean",
        // Next day Toronto — must not appear on DAY.
        scheduledFor: new Date("2030-05-16T16:00:00Z"),
        status: "confirmed",
        lat: 43.7,
        lng: -79.4,
      },
      {
        companyId: companyBId,
        callId: null,
        customerName: "Company B Customer",
        customerPhone: "+15550000004",
        service: "Deep clean",
        scheduledFor: new Date("2030-05-15T16:00:00Z"),
        status: "confirmed",
        lat: 45.0,
        lng: -75.0,
      },
      {
        // A request can have a time and a geocoded address before the
        // customer confirms it. That still does not make it dispatch work.
        companyId: companyAId,
        callId: null,
        customerName: "Pending Located Customer",
        customerPhone: "+15550000005",
        customerAddress: "5 Pending Ave",
        service: "Deep clean",
        scheduledFor: new Date("2030-05-15T18:00:00Z"),
        status: "pending",
        lat: 43.66,
        lng: -79.39,
      },
    ])
    .returning();
  jobAssignedId = bookings[0]!.id;
  jobUnassignedId = bookings[1]!.id;
  jobOtherDayId = bookings[2]!.id;
  jobCompanyBId = bookings[3]!.id;
  jobPendingLocatedId = bookings[4]!.id;

  await db.insert(bookingAssignmentsTable).values({
    bookingId: jobAssignedId,
    teamMemberId: cleanerASeatId,
  });

  // Seed a live location for cleaner A and one for company B's cleaner, so
  // cross-company leakage would be visible if it happened.
  await db.insert(cleanerLocationsTable).values([
    {
      companyId: companyAId,
      teamMemberId: cleanerASeatId,
      lat: 43.6,
      lng: -79.4,
      accuracy: 12.5,
    },
    {
      companyId: companyBId,
      teamMemberId: cleanerBSeatId,
      lat: 45.4,
      lng: -75.7,
    },
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
  resetGeocoder();
  clearGeocodeCache();
  resetDirectionsProvider();
  clearDirectionsCache();
  server?.close();
  const companyIds = [companyAId, companyBId].filter((id) => id != null);
  if (companyIds.length > 0) {
    // Saved stops may point at a booking, and routes point at team members.
    // Delete them before either parent set.
    await db
      .delete(savedRoutesTable)
      .where(inArray(savedRoutesTable.companyId, companyIds));
    const rows = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(inArray(bookingsTable.companyId, companyIds));
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await db
        .delete(bookingAssignmentsTable)
        .where(inArray(bookingAssignmentsTable.bookingId, ids));
    }
    await db
      .delete(cleanerLocationsTable)
      .where(inArray(cleanerLocationsTable.companyId, companyIds));
    await db
      .delete(homeownerPinsTable)
      .where(inArray(homeownerPinsTable.companyId, companyIds));
    await db
      .delete(servicesTable)
      .where(inArray(servicesTable.companyId, companyIds));
    await db
      .delete(activityTable)
      .where(inArray(activityTable.companyId, companyIds));
    await db
      .delete(bookingsTable)
      .where(inArray(bookingsTable.companyId, companyIds));
    await db
      .delete(callsTable)
      .where(inArray(callsTable.companyId, companyIds));
    await db
      .delete(teamMembersTable)
      .where(inArray(teamMembersTable.companyId, companyIds));
    await db
      .delete(companiesTable)
      .where(inArray(companiesTable.id, companyIds));
  }
  await pool.end();
});

describe("GET /map/driving-route", () => {
  it("returns only an actual routed drive", async () => {
    clearDirectionsCache();
    setDirectionsProvider(async (origin, dest) => ({
      etaSeconds: 780,
      distanceMeters: 9100,
      path: [origin, { lat: 53.5, lng: -113.55 }, dest],
      source: "google",
    }));

    const res = await call(
      "GET",
      "/map/driving-route?startLat=53.54&startLng=-113.49&endLat=53.46&endLng=-113.62",
      { as: "dispatcherA" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      distanceMeters: 9100,
      durationSeconds: 780,
      path: [
        { lat: 53.54, lng: -113.49 },
        { lat: 53.5, lng: -113.55 },
        { lat: 53.46, lng: -113.62 },
      ],
    });
  });

  it("says routing is unavailable instead of returning an estimate", async () => {
    clearDirectionsCache();
    setDirectionsProvider(async () => null);

    const res = await call(
      "GET",
      "/map/driving-route?startLat=54&startLng=-114&endLat=55&endLng=-115",
      { as: "ownerA" },
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Driving route unavailable");
    expect(body).not.toHaveProperty("distanceMeters");
  });
});

describe("GET /map/config", () => {
  it("serves the key to a dispatcher and marks it configured", async () => {
    const prev = process.env["GOOGLE_MAPS_API_KEY"];
    process.env["GOOGLE_MAPS_API_KEY"] = "test-maps-key";
    try {
      const res = await call("GET", "/map/config", { as: "dispatcherA" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        apiKey: string;
        configured: boolean;
      };
      expect(body).toEqual({ apiKey: "test-maps-key", configured: true });
    } finally {
      if (prev === undefined) delete process.env["GOOGLE_MAPS_API_KEY"];
      else process.env["GOOGLE_MAPS_API_KEY"] = prev;
    }
  });

  it("returns configured:false and an empty key when unset, never erroring", async () => {
    const prev = process.env["GOOGLE_MAPS_API_KEY"];
    delete process.env["GOOGLE_MAPS_API_KEY"];
    try {
      const res = await call("GET", "/map/config", { as: "ownerA" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        apiKey: string;
        configured: boolean;
      };
      expect(body).toEqual({ apiKey: "", configured: false });
    } finally {
      if (prev !== undefined) process.env["GOOGLE_MAPS_API_KEY"] = prev;
    }
  });
});

describe("GET /map/data", () => {
  it("returns this company's cleaners, geocoded day jobs, and pins", async () => {
    // Asked as the owner on purpose: a dispatcher only sees live positions
    // inside working hours, and this company's zone is fixed, so a dispatcher
    // here would pass or fail depending on what time the suite ran. The
    // working-hours rule has its own tests in staff.devices.test.ts.
    const res = await call("GET", `/map/data?date=${DAY}`, {
      as: "ownerA",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cleaners: Array<{ teamMemberId: number; name: string }>;
      jobs: Array<{ bookingId: number; assignees: Array<{ name: string }> }>;
      pins: Array<{ id: number }>;
    };

    // Only company A's located cleaner.
    expect(body.cleaners.map((c) => c.teamMemberId)).toEqual([cleanerASeatId]);

    const jobIds = body.jobs.map((j) => j.bookingId);
    // Geocoded + on the day + confirmed only.
    expect(jobIds).toContain(jobAssignedId);
    expect(jobIds).not.toContain(jobUnassignedId); // no coordinates
    expect(jobIds).not.toContain(jobOtherDayId); // wrong day
    expect(jobIds).not.toContain(jobCompanyBId); // other company
    expect(jobIds).not.toContain(jobPendingLocatedId); // not confirmed

    const assignedJob = body.jobs.find((j) => j.bookingId === jobAssignedId)!;
    expect(assignedJob.assignees.map((a) => a.name)).toEqual(["Cleaner A One"]);
  });

  it("never leaks another company's cleaners, jobs, or pins", async () => {
    const res = await call("GET", `/map/data?date=${DAY}`, { as: "ownerB" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cleaners: Array<{ teamMemberId: number }>;
      jobs: Array<{ bookingId: number }>;
    };
    expect(body.cleaners.map((c) => c.teamMemberId)).toEqual([cleanerBSeatId]);
    expect(body.jobs.map((j) => j.bookingId)).toEqual([jobCompanyBId]);
    expect(body.jobs.map((j) => j.bookingId)).not.toContain(jobAssignedId);
  });

  it("pins a whole span when the week/month view asks for one", async () => {
    const res = await call("GET", `/map/data?date=${DAY}&end=2030-05-16`, {
      as: "dispatcherA",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: Array<{ bookingId: number }> };
    const jobIds = body.jobs.map((j) => j.bookingId);
    // The next day now counts — that's the point of the range.
    expect(jobIds).toContain(jobAssignedId);
    expect(jobIds).toContain(jobOtherDayId);
    // Still no pinless job and still no other company.
    expect(jobIds).not.toContain(jobUnassignedId);
    expect(jobIds).not.toContain(jobCompanyBId);
    expect(jobIds).not.toContain(jobPendingLocatedId);
  });

  it("shows a cleaner only the houses they're sent to", async () => {
    const res = await call("GET", `/map/data?date=${DAY}&end=2030-05-16`, {
      as: "cleanerA",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jobs: Array<{ bookingId: number; customerAddress: string | null }>;
    };
    // A month-wide map must not hand crew every address the company holds.
    expect(body.jobs.map((j) => j.bookingId)).toEqual([jobAssignedId]);
    const text = JSON.stringify(body.jobs);
    expect(text).not.toContain("Other Day Customer");
    expect(text).not.toContain("Company B Customer");
  });
});

describe("GET /bookings/range", () => {
  it("returns scheduled bookings in the span, pinned or not", async () => {
    const res = await call(
      "GET",
      `/bookings/range?start=${DAY}&end=2030-05-16`,
      { as: "dispatcherA" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      start: string;
      end: string;
      bookings: Array<{
        bookingId: number;
        located: boolean;
        assignees: Array<{ name: string }>;
      }>;
    };
    expect(body.start).toBe(DAY);
    expect(body.end).toBe("2030-05-16");

    const ids = body.bookings.map((b) => b.bookingId);
    expect(ids).toContain(jobAssignedId);
    expect(ids).toContain(jobOtherDayId);
    // Neither a blank pin nor a known address promotes a pending request onto
    // a dispatch calendar.
    expect(ids).not.toContain(jobUnassignedId);
    expect(ids).not.toContain(jobPendingLocatedId);
    expect(ids).not.toContain(jobCompanyBId);
    const located = body.bookings.find((b) => b.bookingId === jobAssignedId)!;
    expect(located.located).toBe(true);
    expect(located.assignees.map((a) => a.name)).toEqual(["Cleaner A One"]);
  });

  it("carries the service and a length for every block, falling back when the booking has none", async () => {
    const res = await call(
      "GET",
      `/bookings/range?start=${DAY}&end=2030-05-16`,
      { as: "dispatcherA" },
    );
    const body = (await res.json()) as {
      bookings: Array<{
        bookingId: number;
        service: string;
        durationMinutes: number;
      }>;
    };

    // The booking's service row says three hours.
    const assigned = body.bookings.find((b) => b.bookingId === jobAssignedId)!;
    expect(assigned.service).toBe("Deep clean");
    expect(assigned.durationMinutes).toBe(180);

    // No service row and no length of its own — the calendar still needs to
    // draw a block, so it gets the two-hour default rather than a zero.
    const mystery = body.bookings.find((b) => b.bookingId === jobOtherDayId)!;
    expect(mystery.service).toBe("Mystery clean");
    expect(mystery.durationMinutes).toBe(120);
  });

  it("carries no price, address or phone number, so crew can read it", async () => {
    const res = await call("GET", `/bookings/range?start=${DAY}&end=${DAY}`, {
      as: "dispatcherA",
    });
    const text = await res.text();
    expect(text).not.toContain("1 Assigned St");
    expect(text).not.toContain("5550000001");
    expect(text).not.toContain("250");
  });

  it("scopes a cleaner to their own jobs", async () => {
    const res = await call(
      "GET",
      `/bookings/range?start=${DAY}&end=2030-05-16`,
      { as: "cleanerA" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bookings: Array<{ bookingId: number }>;
    };
    expect(body.bookings.map((b) => b.bookingId)).toEqual([jobAssignedId]);
  });

  it("rejects a backwards range and an oversized one", async () => {
    const backwards = await call(
      "GET",
      `/bookings/range?start=${DAY}&end=2030-05-14`,
      { as: "dispatcherA" },
    );
    expect(backwards.status).toBe(400);

    const huge = await call(
      "GET",
      `/bookings/range?start=2030-01-01&end=2030-12-31`,
      { as: "dispatcherA" },
    );
    expect(huge.status).toBe(400);
  });

  it("requires both ends of the range", async () => {
    const res = await call("GET", `/bookings/range?start=${DAY}`, {
      as: "dispatcherA",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /staff/location", () => {
  it("upserts the caller's own row and only the caller's", async () => {
    const res = await call("POST", "/staff/location", {
      as: "cleanerA2",
      body: { lat: 43.7, lng: -79.5, accuracy: 8 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { teamMemberId: number; lat: number };
    // Never a body-supplied id — always the caller's own seat.
    expect(body.teamMemberId).toBe(cleanerA2SeatId);
    expect(body.lat).toBe(43.7);
  });

  it("ignores any teamMemberId in the body — a cleaner can't write another's location", async () => {
    const before = await db
      .select()
      .from(cleanerLocationsTable)
      .where(inArray(cleanerLocationsTable.teamMemberId, [cleanerASeatId]));
    const beforeLat = before[0]!.lat;

    const res = await call("POST", "/staff/location", {
      as: "cleanerA2",
      // Attempt to overwrite cleaner A's row.
      body: { teamMemberId: cleanerASeatId, lat: 1.1, lng: 2.2 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { teamMemberId: number };
    expect(body.teamMemberId).toBe(cleanerA2SeatId);

    const after = await db
      .select()
      .from(cleanerLocationsTable)
      .where(inArray(cleanerLocationsTable.teamMemberId, [cleanerASeatId]));
    // Cleaner A's row is untouched.
    expect(after[0]!.lat).toBe(beforeLat);
  });

  it("rejects out-of-range coordinates", async () => {
    const res = await call("POST", "/staff/location", {
      as: "cleanerA2",
      body: { lat: 200, lng: 0 },
    });
    expect(res.status).toBe(400);
  });

  it.skip("lets the owner report through their owner roster row and show up live", async () => {
    // The owner has no caller seat (authority comes from owning the company),
    // but the company's owner-role roster row is their identity everywhere
    // else — chat, roster, map — so the location lands on that same id.
    const res = await call("POST", "/staff/location", {
      as: "ownerA",
      body: { lat: 43.66, lng: -79.39, accuracy: 5 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { teamMemberId: number };
    expect(body.teamMemberId).toBe(ownerASeatId);

    // And the same 5-minute presence rule now lights them up for the crew.
    const presence = await call("GET", "/staff/presence", { as: "cleanerA" });
    expect(presence.status).toBe(200);
    const live = (await presence.json()) as { liveMemberIds: number[] };
    expect(live.liveMemberIds).toContain(ownerASeatId);
  });

  it("still rejects an owner whose company has no owner roster row", async () => {
    // Company B was seeded without one — there is genuinely nowhere to write,
    // and inventing a row here would create a second identity for the owner.
    const res = await call("POST", "/staff/location", {
      as: "ownerB",
      body: { lat: 45.4, lng: -75.7 },
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /schedule", () => {
  it("gives owner/dispatcher every lane plus the unassigned column", async () => {
    const res = await call("GET", `/schedule?date=${DAY}`, {
      as: "dispatcherA",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      date: string;
      cleaners: Array<{
        teamMemberId: number;
        jobs: Array<{ bookingId: number; durationMinutes: number }>;
      }>;
      unassigned: Array<{ bookingId: number; durationMinutes: number }>;
    };
    expect(body.date).toBe(DAY);

    const laneA = body.cleaners.find((c) => c.teamMemberId === cleanerASeatId)!;
    expect(laneA.jobs.map((j) => j.bookingId)).toEqual([jobAssignedId]);
    // Booking has no duration; service "Deep clean" supplies 180.
    expect(laneA.jobs[0]!.durationMinutes).toBe(180);

    // Pending work belongs in Bookings until it is confirmed, even when it
    // already has a date, address, or a crew.
    expect(body.unassigned).toEqual([]);
    // Never another day's job.
    const allIds = [
      ...body.cleaners.flatMap((c) => c.jobs.map((j) => j.bookingId)),
      ...body.unassigned.map((j) => j.bookingId),
    ];
    expect(allIds).not.toContain(jobOtherDayId);
    expect(allIds).not.toContain(jobCompanyBId);
    expect(allIds).not.toContain(jobUnassignedId);
    expect(allIds).not.toContain(jobPendingLocatedId);
  });

  it("attaches a home → job travel leg when both ends are geocoded", async () => {
    // Give cleaner A a geocoded home and their job real coordinates.
    await db
      .update(teamMembersTable)
      .set({ homeLat: 53.5461, homeLng: -113.4938 })
      .where(eq(teamMembersTable.id, cleanerASeatId));
    await db
      .update(bookingsTable)
      .set({ lat: 53.5225, lng: -113.6242 })
      .where(eq(bookingsTable.id, jobAssignedId));

    const res = await call("GET", `/schedule?date=${DAY}`, {
      as: "cleanerA",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cleaners: Array<{
        jobs: Array<{
          travel: {
            fromHome: boolean;
            fromLabel: string;
            distanceKm: number;
            driveMinutes: number;
          } | null;
        }>;
      }>;
    };
    const travel = body.cleaners[0]!.jobs[0]!.travel;
    expect(travel).not.toBeNull();
    expect(travel!.fromHome).toBe(true);
    expect(travel!.distanceKm).toBeGreaterThan(5);
    expect(travel!.distanceKm).toBeLessThan(20);
    expect(travel!.driveMinutes).toBeGreaterThanOrEqual(5);
  });

  it("shows a cleaner only their own lane and only their own jobs", async () => {
    const res = await call("GET", `/schedule?date=${DAY}`, { as: "cleanerA" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cleaners: Array<{
        teamMemberId: number;
        jobs: Array<{ bookingId: number }>;
      }>;
      unassigned: unknown[];
    };
    expect(body.cleaners).toHaveLength(1);
    expect(body.cleaners[0]!.teamMemberId).toBe(cleanerASeatId);
    expect(body.cleaners[0]!.jobs.map((j) => j.bookingId)).toEqual([
      jobAssignedId,
    ]);
    // A cleaner never sees the unassigned column.
    expect(body.unassigned).toEqual([]);
  });

  it("shows an unassigned cleaner an empty lane, never another company's data", async () => {
    const res = await call("GET", `/schedule?date=${DAY}`, {
      as: "cleanerA2",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cleaners: Array<{ teamMemberId: number; jobs: unknown[] }>;
    };
    expect(body.cleaners[0]!.teamMemberId).toBe(cleanerA2SeatId);
    expect(body.cleaners[0]!.jobs).toEqual([]);
  });

  it("moves a job assigned only to a retired cleaner back to needs a crew", async () => {
    await db
      .update(teamMembersTable)
      .set({ active: false })
      .where(eq(teamMembersTable.id, cleanerASeatId));

    const res = await call("GET", `/schedule?date=${DAY}`, {
      as: "dispatcherA",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cleaners: Array<{
        teamMemberId: number;
        jobs: Array<{ bookingId: number }>;
      }>;
      unassigned: Array<{ bookingId: number }>;
    };
    expect(
      body.cleaners.some((lane) => lane.teamMemberId === cleanerASeatId),
    ).toBe(false);
    expect(body.unassigned.map((job) => job.bookingId)).toContain(
      jobAssignedId,
    );
  });
});

describe("POST /map/pins and DELETE /map/pins/:id", () => {
  it("geocodes an address via the injected stub and stores the pin", async () => {
    setGeocoder(async () => ({ lat: 43.642, lng: -79.387 }));
    clearGeocodeCache();
    const res = await call("POST", "/map/pins", {
      as: "dispatcherA",
      body: { name: "CN Tower", address: "290 Bremner Blvd" },
    });
    expect(res.status).toBe(201);
    const pin = (await res.json()) as {
      id: number;
      lat: number;
      lng: number;
    };
    expect(pin.lat).toBe(43.642);

    // Shows up on this company's map...
    const map = await call("GET", `/map/data?date=${DAY}`, {
      as: "dispatcherA",
    });
    const pins = ((await map.json()) as { pins: Array<{ id: number }> }).pins;
    expect(pins.map((p) => p.id)).toContain(pin.id);

    // ...but not another company's.
    const mapB = await call("GET", `/map/data?date=${DAY}`, { as: "ownerB" });
    const pinsB = ((await mapB.json()) as { pins: Array<{ id: number }> }).pins;
    expect(pinsB.map((p) => p.id)).not.toContain(pin.id);

    // And it deletes, company-scoped.
    const del = await call("DELETE", `/map/pins/${pin.id}`, {
      as: "dispatcherA",
    });
    expect(del.status).toBe(204);
  });

  it("400s when the stub geocoder cannot resolve the address", async () => {
    // Google almost never returns ZERO_RESULTS; the failure path is only
    // exercisable via a stub, never a fake address.
    setGeocoder(async () => null);
    clearGeocodeCache();
    const res = await call("POST", "/map/pins", {
      as: "dispatcherA",
      body: { name: "Nowhere", address: "asdkjfhaskjdfh" },
    });
    expect(res.status).toBe(400);
  });

  it("PATCH renames without moving, re-geocodes a new address, and rejects half a coordinate", async () => {
    const [pin] = await db
      .insert(homeownerPinsTable)
      .values({
        companyId: companyAId,
        name: "Old name",
        address: "1 Old St",
        lat: 50,
        lng: -100,
      })
      .returning();

    // Rename only — coordinates untouched.
    const rename = await call("PATCH", `/map/pins/${pin!.id}`, {
      as: "dispatcherA",
      body: { name: "New name" },
    });
    expect(rename.status).toBe(200);
    const renamed = (await rename.json()) as {
      name: string;
      lat: number;
      lng: number;
    };
    expect(renamed.name).toBe("New name");
    expect(renamed.lat).toBe(50);
    expect(renamed.lng).toBe(-100);

    // A new address without coordinates is re-geocoded.
    setGeocoder(async () => ({ lat: 51.5, lng: -101.5 }));
    clearGeocodeCache();
    const readdress = await call("PATCH", `/map/pins/${pin!.id}`, {
      as: "dispatcherA",
      body: { address: "2 New Ave" },
    });
    expect(readdress.status).toBe(200);
    const moved = (await readdress.json()) as {
      address: string | null;
      lat: number;
      lng: number;
    };
    expect(moved.address).toBe("2 New Ave");
    expect(moved.lat).toBe(51.5);

    // Explicit coordinates win (a map-click move).
    const clickMove = await call("PATCH", `/map/pins/${pin!.id}`, {
      as: "dispatcherA",
      body: { lat: 52, lng: -102, address: null },
    });
    expect(clickMove.status).toBe(200);
    const clicked = (await clickMove.json()) as {
      address: string | null;
      lat: number;
    };
    expect(clicked.lat).toBe(52);
    expect(clicked.address).toBeNull();

    // Half a coordinate is a 400, never a silent no-op.
    const half = await call("PATCH", `/map/pins/${pin!.id}`, {
      as: "dispatcherA",
      body: { name: "X", lat: 53 },
    });
    expect(half.status).toBe(400);

    // An empty body changes nothing and says so.
    const empty = await call("PATCH", `/map/pins/${pin!.id}`, {
      as: "dispatcherA",
      body: {},
    });
    expect(empty.status).toBe(400);
  });

  it("a company can only update its own pins", async () => {
    const [pin] = await db
      .insert(homeownerPinsTable)
      .values({
        companyId: companyBId,
        name: "B's pin",
        lat: 45,
        lng: -75,
      })
      .returning();
    const res = await call("PATCH", `/map/pins/${pin!.id}`, {
      as: "dispatcherA",
      body: { name: "Hijack" },
    });
    expect(res.status).toBe(404);
  });

  it("a company can only delete its own pins", async () => {
    const [pin] = await db
      .insert(homeownerPinsTable)
      .values({
        companyId: companyBId,
        name: "B's pin",
        lat: 45,
        lng: -75,
      })
      .returning();
    // Company A dispatcher cannot delete company B's pin.
    const res = await call("DELETE", `/map/pins/${pin!.id}`, {
      as: "dispatcherA",
    });
    expect(res.status).toBe(404);
  });
});

describe("saved cleaner routes", () => {
  it("persists named routes and their exact ordered stops without creating bookings", async () => {
    const before = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.companyId, companyAId));

    const create = await call("POST", "/saved-routes", {
      as: "dispatcherA",
      body: {
        name: "West end extras",
        teamMemberId: cleanerA2SeatId,
      },
    });
    expect(create.status).toBe(201);
    const route = (await create.json()) as {
      id: number;
      name: string;
      teamMemberId: number;
      stops: unknown[];
    };
    expect(route).toMatchObject({
      name: "West end extras",
      teamMemberId: cleanerA2SeatId,
      stops: [],
    });

    const first = await call("POST", `/saved-routes/${route.id}/stops`, {
      as: "ownerA",
      body: {
        name: "Loose map click",
        address: null,
        lat: 53.512345,
        lng: -113.612345,
      },
    });
    const second = await call("POST", `/saved-routes/${route.id}/stops`, {
      as: "dispatcherA",
      body: {
        name: "Search result",
        address: "100 Test Avenue",
        lat: 53.523456,
        lng: -113.623456,
      },
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstStop = (await first.json()) as { id: number; position: number };
    const secondStop = (await second.json()) as {
      id: number;
      position: number;
    };
    expect([firstStop.position, secondStop.position]).toEqual([0, 1]);

    const reorder = await call(
      "PUT",
      `/saved-routes/${route.id}/stops/reorder`,
      {
        as: "dispatcherA",
        body: { stopIds: [secondStop.id, firstStop.id] },
      },
    );
    expect(reorder.status).toBe(200);
    const reordered = (await reorder.json()) as {
      stops: Array<{ id: number; position: number; address: string | null }>;
    };
    expect(reordered.stops.map((stop) => stop.id)).toEqual([
      secondStop.id,
      firstStop.id,
    ]);
    expect(reordered.stops.map((stop) => stop.position)).toEqual([0, 1]);
    expect(reordered.stops[1]!.address).toBeNull();

    const incomplete = await call(
      "PUT",
      `/saved-routes/${route.id}/stops/reorder`,
      {
        as: "dispatcherA",
        body: { stopIds: [firstStop.id] },
      },
    );
    expect(incomplete.status).toBe(400);

    const remove = await call(
      "DELETE",
      `/saved-routes/${route.id}/stops/${firstStop.id}`,
      { as: "dispatcherA" },
    );
    expect(remove.status).toBe(204);
    const reloaded = await call("GET", `/saved-routes/${route.id}`, {
      as: "ownerA",
    });
    const saved = (await reloaded.json()) as {
      stops: Array<{ id: number }>;
    };
    expect(saved.stops.map((stop) => stop.id)).toEqual([secondStop.id]);

    const after = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.companyId, companyAId));
    expect(after).toHaveLength(before.length);
  });

  it("serializes simultaneous stop appends into unique positions", async () => {
    const create = await call("POST", "/saved-routes", {
      as: "dispatcherA",
      body: {
        name: "Concurrent append route",
        teamMemberId: cleanerA2SeatId,
      },
    });
    const route = (await create.json()) as { id: number };

    const responses = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        call("POST", `/saved-routes/${route.id}/stops`, {
          as: index % 2 === 0 ? "ownerA" : "dispatcherA",
          body: {
            name: `Concurrent stop ${index + 1}`,
            address: null,
            lat: 53.51 + index / 1000,
            lng: -113.51 - index / 1000,
          },
        }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([
      201, 201, 201, 201,
    ]);

    const reload = await call("GET", `/saved-routes/${route.id}`, {
      as: "dispatcherA",
    });
    const saved = (await reload.json()) as {
      stops: Array<{ position: number }>;
    };
    expect(saved.stops.map((stop) => stop.position)).toEqual([0, 1, 2, 3]);
  });

  it("is private to its company and unavailable to cleaners", async () => {
    const other = await call("POST", "/saved-routes", {
      as: "ownerB",
      body: { name: "Company B route", teamMemberId: cleanerBSeatId },
    });
    expect(other.status).toBe(201);
    const route = (await other.json()) as { id: number };

    expect(
      (await call("GET", `/saved-routes/${route.id}`, { as: "ownerA" })).status,
    ).toBe(404);
    expect(
      (
        await call("PATCH", `/saved-routes/${route.id}`, {
          as: "dispatcherA",
          body: { name: "Not ours" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call("GET", "/saved-routes", { as: "cleanerA2" })).status,
    ).toBe(403);
  });

  it("atomically links one booking and preserves exact stop coordinates", async () => {
    const create = await call("POST", "/saved-routes", {
      as: "dispatcherA",
      body: {
        name: "Ready to schedule",
        teamMemberId: cleanerA2SeatId,
      },
    });
    const route = (await create.json()) as { id: number };
    const add = await call("POST", `/saved-routes/${route.id}/stops`, {
      as: "dispatcherA",
      body: {
        name: "Mrs. Route",
        address: null,
        lat: 53.512345,
        lng: -113.612345,
      },
    });
    const stop = (await add.json()) as { id: number };

    const bookingBody = {
      customerName: "Mrs. Route",
      customerPhone: "780-555-0199",
      service: "Deep clean",
      scheduledFor: "2030-06-01T16:00:00.000Z",
      routeStopId: stop.id,
    };
    const [firstAttempt, secondAttempt] = await Promise.all([
      call("POST", "/bookings", {
        as: "dispatcherA",
        body: bookingBody,
      }),
      call("POST", "/bookings", {
        as: "ownerA",
        body: {
          ...bookingBody,
          customerName: "Duplicate Mrs. Route",
        },
      }),
    ]);
    expect([firstAttempt.status, secondAttempt.status].sort()).toEqual([
      201, 409,
    ]);
    const bookingRes =
      firstAttempt.status === 201 ? firstAttempt : secondAttempt;
    const booking = (await bookingRes.json()) as {
      id: number;
      lat: number | null;
      lng: number | null;
    };
    expect(booking).toMatchObject({
      lat: 53.512345,
      lng: -113.612345,
    });

    const routeBookings = await db
      .select({
        id: bookingsTable.id,
        lat: bookingsTable.lat,
        lng: bookingsTable.lng,
      })
      .from(bookingsTable)
      .where(
        inArray(bookingsTable.customerName, [
          "Mrs. Route",
          "Duplicate Mrs. Route",
        ]),
      );
    expect(routeBookings).toEqual([
      expect.objectContaining({
        id: booking.id,
        lat: 53.512345,
        lng: -113.612345,
      }),
    ]);

    const assignments = await db
      .select({ teamMemberId: bookingAssignmentsTable.teamMemberId })
      .from(bookingAssignmentsTable)
      .where(eq(bookingAssignmentsTable.bookingId, booking.id));
    expect(assignments.map((row) => row.teamMemberId)).toEqual([
      cleanerA2SeatId,
    ]);

    const [linked] = await db
      .select({ linkedBookingId: savedRouteStopsTable.linkedBookingId })
      .from(savedRouteStopsTable)
      .where(eq(savedRouteStopsTable.id, stop.id));
    expect(linked?.linkedBookingId).toBe(booking.id);
  });

  it("rejects a foreign stop before creating any booking", async () => {
    const routeRes = await call("POST", "/saved-routes", {
      as: "ownerB",
      body: {
        name: "Private company B stop",
        teamMemberId: cleanerBSeatId,
      },
    });
    const route = (await routeRes.json()) as { id: number };
    const stopRes = await call("POST", `/saved-routes/${route.id}/stops`, {
      as: "ownerB",
      body: {
        name: "Not company A's",
        address: null,
        lat: 45,
        lng: -75,
      },
    });
    const stop = (await stopRes.json()) as { id: number };
    const before = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.companyId, companyAId));

    const res = await call("POST", "/bookings", {
      as: "dispatcherA",
      body: {
        customerName: "Should not save",
        customerPhone: "780-555-0100",
        service: "Deep clean",
        scheduledFor: "2030-06-01T16:00:00.000Z",
        routeStopId: stop.id,
      },
    });
    expect(res.status).toBe(400);

    const after = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.companyId, companyAId));
    expect(after).toHaveLength(before.length);
    const [stillUnlinked] = await db
      .select({ linkedBookingId: savedRouteStopsTable.linkedBookingId })
      .from(savedRouteStopsTable)
      .where(eq(savedRouteStopsTable.id, stop.id));
    expect(stillUnlinked?.linkedBookingId).toBeNull();
  });
});
