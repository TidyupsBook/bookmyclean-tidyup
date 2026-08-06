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
  servicesTable,
  activityTable,
  callsTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import {
  setGeocoder,
  resetGeocoder,
  clearGeocodeCache,
} from "../services/geocode";

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
let cleanerASeatId: number;
let cleanerA2SeatId: number;
let cleanerBSeatId: number;
// Two jobs on the target day for company A, one geocoded, one not.
let jobAssignedId: number;
let jobUnassignedId: number;
let jobOtherDayId: number;
let jobCompanyBId: number;

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
        status: "active",
        clerkUserId: USERS.cleanerA,
      },
      {
        companyId: companyAId,
        name: "Cleaner A Two",
        email: `cleanerA2_${runId}@test.invalid`,
        role: "cleaner",
        status: "active",
        clerkUserId: USERS.cleanerA2,
      },
      {
        companyId: companyBId,
        name: "Cleaner B",
        email: `cleanerB_${runId}@test.invalid`,
        role: "cleaner",
        status: "active",
        clerkUserId: USERS.cleanerB,
      },
    ])
    .returning();
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
        service: "Deep clean",
        // Next day Toronto — must not appear on DAY.
        scheduledFor: new Date("2030-05-16T16:00:00Z"),
        status: "pending",
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
        status: "pending",
        lat: 45.0,
        lng: -75.0,
      },
    ])
    .returning();
  jobAssignedId = bookings[0]!.id;
  jobUnassignedId = bookings[1]!.id;
  jobOtherDayId = bookings[2]!.id;
  jobCompanyBId = bookings[3]!.id;

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
  server?.close();
  const companyIds = [companyAId, companyBId].filter((id) => id != null);
  if (companyIds.length > 0) {
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
    const res = await call("GET", `/map/data?date=${DAY}`, {
      as: "dispatcherA",
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
    // Geocoded + on the day only.
    expect(jobIds).toContain(jobAssignedId);
    expect(jobIds).not.toContain(jobUnassignedId); // no coordinates
    expect(jobIds).not.toContain(jobOtherDayId); // wrong day
    expect(jobIds).not.toContain(jobCompanyBId); // other company

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
  it("returns every booking in the span, pinned or not", async () => {
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
    // The un-geocoded job MUST show — a calendar that hides it makes a busy
    // afternoon look free.
    expect(ids).toContain(jobUnassignedId);
    expect(ids).not.toContain(jobCompanyBId);

    const unlocated = body.bookings.find(
      (b) => b.bookingId === jobUnassignedId,
    )!;
    expect(unlocated.located).toBe(false);
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
    const mystery = body.bookings.find((b) => b.bookingId === jobUnassignedId)!;
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

    expect(body.unassigned.map((j) => j.bookingId)).toEqual([jobUnassignedId]);
    // No booking duration and no matching service — falls back to 120.
    expect(body.unassigned[0]!.durationMinutes).toBe(120);
    // Never another day's job.
    const allIds = [
      ...body.cleaners.flatMap((c) => c.jobs.map((j) => j.bookingId)),
      ...body.unassigned.map((j) => j.bookingId),
    ];
    expect(allIds).not.toContain(jobOtherDayId);
    expect(allIds).not.toContain(jobCompanyBId);
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
