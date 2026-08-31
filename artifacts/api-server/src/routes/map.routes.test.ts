/**
 * GET /map/routes — the cleaner-to-next-job trails.
 *
 * Same live-app-against-real-DB style as map.test.ts: Clerk is the only thing
 * mocked (caller id via x-test-user), plus the Directions provider swapped for
 * a deterministic fake so no test ever pays Google.
 *
 * The endpoint always answers for "today in the company's zone", so instead of
 * a fixed date these fixtures schedule around the wall clock — in a company
 * timezone picked at runtime to be mid-morning, keeping every offset used here
 * safely inside one local day no matter when the suite runs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import {
  setDirectionsProvider,
  resetDirectionsProvider,
  clearDirectionsCache,
  type DrivingRoute,
} from "../services/directions";

const runId = `${Date.now()}_${process.pid}`;
const USERS: Record<string, string> = {
  ownerA: `routes_ownerA_${runId}`,
  dispatcherA: `routes_dispatcherA_${runId}`,
  cleanerA: `routes_cleanerA_${runId}`,
  cleanerA2: `routes_cleanerA2_${runId}`,
  cleanerB: `routes_cleanerB_${runId}`,
};

/**
 * A zone where it is currently mid-morning-ish, so "now ± a few hours" stays
 * inside one local calendar day. The endpoint works off "today in the
 * company's zone"; anchoring the fixtures mid-day makes that day stable.
 */
function middayZone(): string {
  const zones = [
    "Pacific/Honolulu",
    "America/Anchorage",
    "America/Denver",
    "America/Toronto",
    "America/Sao_Paulo",
    "UTC",
    "Europe/Berlin",
    "Asia/Dubai",
    "Asia/Karachi",
    "Asia/Bangkok",
    "Asia/Tokyo",
    "Pacific/Auckland",
  ];
  for (const timeZone of zones) {
    const hour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "numeric",
        hourCycle: "h23",
      }).format(new Date()),
    );
    if (hour >= 8 && hour <= 15) return timeZone;
  }
  return "UTC";
}

const NOW = new Date();
const inMinutes = (mins: number) => new Date(NOW.getTime() + mins * 60_000);

// Destinations. The fake provider answers with a real-looking route for D1
// and refuses D2, forcing the straight-line estimate path.
const D1 = { lat: 43.65, lng: -79.38 };
const D2 = { lat: 43.7, lng: -79.3 };
const ORIGIN_A = { lat: 43.6, lng: -79.4 };
const ORIGIN_A2 = { lat: 43.58, lng: -79.42 };

const GOOGLE_ROUTE: DrivingRoute = {
  etaSeconds: 600,
  distanceMeters: 4000,
  path: [ORIGIN_A, { lat: 43.62, lng: -79.39 }, D1],
  source: "google",
};

let server: http.Server;
let baseUrl: string;

let companyAId: number;
let companyBId: number;
let cleanerASeatId: number;
let cleanerA2SeatId: number;
let staleSeatId: number;
let cleanerBSeatId: number;
let jobSoonId: number;
let jobLaterId: number;
let jobEstimateId: number;
let jobBId: number;

async function call(path: string, as?: keyof typeof USERS): Promise<Response> {
  const headers: Record<string, string> = {};
  if (as) headers["x-test-user"] = USERS[as]!;
  return fetch(`${baseUrl}/api${path}`, { headers });
}

beforeAll(async () => {
  clearDirectionsCache();
  setDirectionsProvider(async (_origin, dest) => {
    const isD2 =
      Math.abs(dest.lat - D2.lat) < 1e-6 && Math.abs(dest.lng - D2.lng) < 1e-6;
    return isD2 ? null : GOOGLE_ROUTE;
  });

  const timezone = middayZone();
  const [companyA] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: USERS.ownerA,
      name: `Routes Co A ${runId}`,
      timezone,
    })
    .returning();
  const [companyB] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `routes_ownerB_${runId}`,
      name: `Routes Co B ${runId}`,
      timezone,
    })
    .returning();
  companyAId = companyA!.id;
  companyBId = companyB!.id;

  const seats = await db
    .insert(teamMembersTable)
    .values([
      {
        companyId: companyAId,
        name: "You",
        email: `routes_ownerA_${runId}@test.invalid`,
        role: "owner",
        status: "active",
        clerkUserId: USERS.ownerA,
      },
      {
        companyId: companyAId,
        name: "Dispatcher A",
        email: `routes_disp_${runId}@test.invalid`,
        role: "dispatcher",
        status: "active",
        clerkUserId: USERS.dispatcherA,
      },
      {
        companyId: companyAId,
        name: "Cleaner A One",
        email: `routes_cleanerA_${runId}@test.invalid`,
        role: "cleaner",
        // Tracking is opt-in per person now; this crew is switched on.
        locationSharing: true,
        status: "active",
        clerkUserId: USERS.cleanerA,
      },
      {
        companyId: companyAId,
        name: "Cleaner A Two",
        email: `routes_cleanerA2_${runId}@test.invalid`,
        role: "cleaner",
        // Tracking is opt-in per person now; this crew is switched on.
        locationSharing: true,
        status: "active",
        clerkUserId: USERS.cleanerA2,
      },
      {
        // Live-window control: has a job today but her phone went quiet.
        companyId: companyAId,
        name: "Stale Cleaner",
        email: `routes_stale_${runId}@test.invalid`,
        role: "cleaner",
        // Tracking is opt-in per person now; this crew is switched on.
        locationSharing: true,
        status: "active",
      },
      {
        companyId: companyBId,
        name: "Cleaner B",
        email: `routes_cleanerB_${runId}@test.invalid`,
        role: "cleaner",
        // Tracking is opt-in per person now; this crew is switched on.
        locationSharing: true,
        status: "active",
        clerkUserId: USERS.cleanerB,
      },
    ])
    .returning();
  cleanerASeatId = seats.find((s) => s.clerkUserId === USERS.cleanerA)!.id;
  cleanerA2SeatId = seats.find((s) => s.clerkUserId === USERS.cleanerA2)!.id;
  staleSeatId = seats.find((s) => s.name === "Stale Cleaner")!.id;
  cleanerBSeatId = seats.find((s) => s.clerkUserId === USERS.cleanerB)!.id;

  const bookings = await db
    .insert(bookingsTable)
    .values([
      {
        // Cleaner A's actual next job: booked for right now, still inside
        // its window. No duration on file → the two-hour default applies.
        companyId: companyAId,
        callId: null,
        customerName: "Soon Customer",
        customerPhone: "+15550000101",
        customerAddress: "1 Soon St",
        service: "Deep clean",
        scheduledFor: NOW,
        status: "confirmed",
        lat: D1.lat,
        lng: D1.lng,
      },
      {
        // Also cleaner A's, but hours later — must lose to the one above.
        companyId: companyAId,
        callId: null,
        customerName: "Later Customer",
        customerPhone: "+15550000102",
        service: "Deep clean",
        scheduledFor: inMinutes(180),
        status: "confirmed",
        lat: D1.lat,
        lng: D1.lng,
      },
      {
        // Earlier than everything but has no pin — the map can't draw a
        // trail to an address it never geocoded, so this must be skipped.
        companyId: companyAId,
        callId: null,
        customerName: "Unpinned Customer",
        customerPhone: "+15550000103",
        service: "Deep clean",
        scheduledFor: inMinutes(-10),
        status: "confirmed",
      },
      {
        // Finished twenty minutes ago — never a destination.
        companyId: companyAId,
        callId: null,
        customerName: "Done Customer",
        customerPhone: "+15550000104",
        service: "Deep clean",
        scheduledFor: inMinutes(-20),
        status: "completed",
        lat: D1.lat,
        lng: D1.lng,
      },
      {
        // This is a plausible, geocoded request, but it has not been
        // confirmed and must never generate a route trail.
        companyId: companyAId,
        callId: null,
        customerName: "Pending Route Customer",
        customerPhone: "+15550000105",
        service: "Deep clean",
        scheduledFor: inMinutes(60),
        status: "pending",
        lat: D2.lat,
        lng: D2.lng,
      },
      {
        // The stale cleaner's job — she's off the map, so no trail.
        companyId: companyAId,
        callId: null,
        customerName: "Stale Customer",
        customerPhone: "+15550000106",
        service: "Deep clean",
        scheduledFor: inMinutes(60),
        status: "confirmed",
        lat: D1.lat,
        lng: D1.lng,
      },
      {
        companyId: companyBId,
        callId: null,
        customerName: "Company B Customer",
        customerPhone: "+15550000107",
        service: "Deep clean",
        scheduledFor: NOW,
        status: "confirmed",
        lat: 45.42,
        lng: -75.7,
      },
      {
        // A later confirmed job gives Cleaner A Two a legitimate destination.
        // The pending request above must not win just because it is earlier.
        companyId: companyAId,
        callId: null,
        customerName: "Estimate Customer",
        customerPhone: "+15550000108",
        service: "Deep clean",
        scheduledFor: inMinutes(90),
        status: "confirmed",
        lat: D2.lat,
        lng: D2.lng,
      },
    ])
    .returning();
  jobSoonId = bookings[0]!.id;
  jobLaterId = bookings[1]!.id;
  jobBId = bookings[6]!.id;
  jobEstimateId = bookings[7]!.id;

  await db.insert(bookingAssignmentsTable).values([
    { bookingId: jobSoonId, teamMemberId: cleanerASeatId },
    { bookingId: jobLaterId, teamMemberId: cleanerASeatId },
    { bookingId: bookings[2]!.id, teamMemberId: cleanerASeatId },
    { bookingId: bookings[3]!.id, teamMemberId: cleanerASeatId },
    { bookingId: bookings[4]!.id, teamMemberId: cleanerA2SeatId },
    { bookingId: jobEstimateId, teamMemberId: cleanerA2SeatId },
    { bookingId: bookings[5]!.id, teamMemberId: staleSeatId },
    { bookingId: jobBId, teamMemberId: cleanerBSeatId },
  ]);

  await db.insert(cleanerLocationsTable).values([
    {
      companyId: companyAId,
      teamMemberId: cleanerASeatId,
      lat: ORIGIN_A.lat,
      lng: ORIGIN_A.lng,
    },
    {
      companyId: companyAId,
      teamMemberId: cleanerA2SeatId,
      lat: ORIGIN_A2.lat,
      lng: ORIGIN_A2.lng,
    },
    {
      // Ten minutes past the live window — her trail must not be drawn.
      companyId: companyAId,
      teamMemberId: staleSeatId,
      lat: 43.5,
      lng: -79.5,
      updatedAt: inMinutes(-15),
    },
    {
      companyId: companyBId,
      teamMemberId: cleanerBSeatId,
      lat: 45.4,
      lng: -75.71,
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
  resetDirectionsProvider();
  clearDirectionsCache();
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
      .delete(bookingsTable)
      .where(inArray(bookingsTable.companyId, companyIds));
    await db
      .delete(teamMembersTable)
      .where(inArray(teamMembersTable.companyId, companyIds));
    await db
      .delete(companiesTable)
      .where(inArray(companiesTable.id, companyIds));
  }
  await pool.end();
});

type Leg = {
  teamMemberId: number;
  bookingId: number;
  customerName: string;
  source: string;
  etaSeconds: number;
  path: Array<{ lat: number; lng: number }>;
  destLat: number;
  destLng: number;
  scheduledFor: string;
};

describe("GET /map/routes", () => {
  it("gives dispatch one trail per live cleaner, each to their earliest relevant job", async () => {
    const res = await call("/map/routes", "dispatcherA");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { routes: Leg[] };

    // Exactly the two live cleaners — never the stale one or company B.
    expect(body.routes.map((r) => r.teamMemberId).sort()).toEqual(
      [cleanerASeatId, cleanerA2SeatId].sort(),
    );

    const legA = body.routes.find((r) => r.teamMemberId === cleanerASeatId)!;
    // The "right now" job wins over the later one; the unpinned and the
    // completed ones — though earlier — were never candidates.
    expect(legA.bookingId).toBe(jobSoonId);
    expect(legA.customerName).toBe("Soon Customer");
    expect(legA.source).toBe("google");
    expect(legA.etaSeconds).toBe(600);
    expect(legA.path).toHaveLength(3);
    expect(legA.destLat).toBeCloseTo(D1.lat, 6);
    expect(legA.destLng).toBeCloseTo(D1.lng, 6);
    expect(new Date(legA.scheduledFor).getTime()).toBe(new Date(NOW).getTime());
  });

  it("skips an unconfirmed request and falls back to a labelled straight-line estimate", async () => {
    const res = await call("/map/routes", "dispatcherA");
    const body = (await res.json()) as { routes: Leg[] };
    const legA2 = body.routes.find((r) => r.teamMemberId === cleanerA2SeatId)!;

    expect(legA2.bookingId).toBe(jobEstimateId);
    expect(legA2.source).toBe("estimate");
    // Straight line: exactly the origin and the destination.
    expect(legA2.path).toHaveLength(2);
    expect(legA2.path[0]!.lat).toBeCloseTo(ORIGIN_A2.lat, 6);
    expect(legA2.path[1]!.lat).toBeCloseTo(D2.lat, 6);
    expect(legA2.etaSeconds).toBeGreaterThanOrEqual(5 * 60);
  });

  it("shows a cleaner their own trail and nobody else's", async () => {
    const res = await call("/map/routes", "cleanerA");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { routes: Leg[] };
    expect(body.routes).toHaveLength(1);
    expect(body.routes[0]!.teamMemberId).toBe(cleanerASeatId);
    expect(body.routes[0]!.bookingId).toBe(jobSoonId);
  });

  it("keeps companies apart in both directions", async () => {
    const res = await call("/map/routes", "cleanerB");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { routes: Leg[] };
    expect(body.routes).toHaveLength(1);
    expect(body.routes[0]!.teamMemberId).toBe(cleanerBSeatId);
    expect(body.routes[0]!.bookingId).toBe(jobBId);
  });

  it("turns away the signed-out", async () => {
    const res = await call("/map/routes");
    expect(res.status).toBe(401);
  });
});
