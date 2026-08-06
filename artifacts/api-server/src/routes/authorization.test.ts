/**
 * Role-based authorization matrix for the whole API surface.
 *
 * These are live integration tests: the real Express app is started against
 * the real database, with only Clerk mocked (the caller's user id is taken
 * from an `x-test-user` header instead of a session). Three accounts are
 * seeded — an owner, a dispatcher and a cleaner in the same company — and
 * every authenticated route is called as each of them, asserting the exact
 * roles that may pass.
 *
 * Two safety nets:
 *  1. The role matrix below is the source of truth for who may call what.
 *  2. A coverage test walks the live router and fails when a route exists
 *     that the matrix does not mention — so a new route without a role guard
 *     is caught here rather than shipping open.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type http from "node:http";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

// Auth is the only thing mocked: the user id comes from a test header. Role
// resolution, company scoping and every guard under test run for real.
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
import router from "./index";
import {
  db,
  pool,
  companiesTable,
  teamMembersTable,
  bookingsTable,
  bookingAssignmentsTable,
  activityTable,
  callsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

type Role = "owner" | "dispatcher" | "cleaner";
const ROLES: Role[] = ["owner", "dispatcher", "cleaner"];

const runId = `${Date.now()}_${process.pid}`;
const USERS: Record<Role, string> = {
  owner: `test_authz_owner_${runId}`,
  dispatcher: `test_authz_dispatcher_${runId}`,
  cleaner: `test_authz_cleaner_${runId}`,
};

/**
 * Every authenticated route in the API and the roles allowed to call it.
 * A route missing from this table fails the coverage test below.
 *
 * The `:id`/`:token` placeholder is substituted with an id that exists in no
 * seeded row, so "allowed" calls prove only that the role gets PAST the guard
 * (any status except 401/403); blocked calls must be exactly 403.
 */
const MATRIX: Record<string, Role[]> = {
  // Company configuration and go-live: the owner's alone.
  "GET /company": ["owner", "dispatcher", "cleaner"], // shared config (name, timezone) the apps need
  "POST /company": ["owner"],
  "PATCH /company": ["owner"],
  "POST /company/jobber/connect": ["owner"],
  "POST /company/jobber/disconnect": ["owner"],
  "POST /company/jobber/skip": ["owner"],
  // Pulling the Jobber calendar is day-to-day dispatch work, not a settings
  // change, so a dispatcher may trigger it.
  "POST /company/jobber/sync-calendar": ["owner", "dispatcher"],
  "POST /company/go-live": ["owner"],
  // Quo connection and numbers: owner only.
  "POST /company/quo/connect": ["owner"],
  "POST /company/quo/disconnect": ["owner"],
  "GET /quo/numbers": ["owner"],
  "POST /quo/numbers": ["owner"],
  // Service pricing: cleaners may not even read it.
  "GET /services": ["owner", "dispatcher"],
  "POST /services": ["owner"],
  "PATCH /services/:id": ["owner"],
  "DELETE /services/:id": ["owner"],
  // Profile: everyone signed in.
  "GET /me": ["owner", "dispatcher", "cleaner"],
  // Staff: dispatchers may look and keep the roster tidy (phone numbers, home
  // addresses, who is on this week). Adding, removing, and changing anyone's
  // role or email — the things that decide who can sign in and see what — stay
  // with the owner.
  "GET /team": ["owner", "dispatcher"],
  "POST /team": ["owner"],
  "PATCH /team/:id": ["owner", "dispatcher"],
  "POST /team/import": ["owner"],
  "DELETE /team/:id": ["owner"],
  // Calls and transcripts: customer phone numbers and recordings — never crew.
  "GET /calls": ["owner", "dispatcher"],
  "POST /calls/sync": ["owner", "dispatcher"],
  "GET /calls/:id": ["owner", "dispatcher"],
  "GET /calls/:id/booking-draft": ["owner", "dispatcher"],
  "POST /calls/simulate": ["owner", "dispatcher"],
  // Reads text and hands back suggestions; saves nothing. Still dispatch-only,
  // because what it reads is a customer talking on the phone.
  "POST /booking-drafts": ["owner", "dispatcher"],
  // Bookings: cleaners see their own jobs (scoping asserted separately below).
  "GET /bookings": ["owner", "dispatcher", "cleaner"],
  // Calendar rows for the live map. Cleaner-safe by construction — the shape
  // carries no price, address or phone number (see the route's comment).
  "GET /bookings/range": ["owner", "dispatcher", "cleaner"],
  "POST /bookings": ["owner", "dispatcher"],
  "PATCH /bookings/:id": ["owner", "dispatcher", "cleaner"],
  "PUT /bookings/:id/crew": ["owner", "dispatcher"],
  "GET /bookings/:id/quote-preview": ["owner", "dispatcher"],
  "POST /bookings/:id/send-quote": ["owner", "dispatcher"],
  "POST /bookings/:id/confirm-time": ["owner", "dispatcher"],
  "POST /bookings/:id/send-reschedule-text": ["owner", "dispatcher"],
  "POST /bookings/:id/sync-jobber": ["owner", "dispatcher"],
  // Dashboard: crew may read the headline counts and follow the activity feed.
  // The feed quotes customer phone numbers and deposit amounts, so those are
  // masked for cleaners in the handler (see crewRedaction.ts).
  "GET /dashboard/summary": ["owner", "dispatcher", "cleaner"],
  "GET /dashboard/activity": ["owner", "dispatcher", "cleaner"],
  // Live map: crew may watch the day (jobs, coworkers, saved pins); only
  // dispatch may add or remove the saved pins.
  "GET /map/config": ["owner", "dispatcher", "cleaner"],
  "GET /map/data": ["owner", "dispatcher", "cleaner"],
  "POST /map/pins": ["owner", "dispatcher"],
  "DELETE /map/pins/:id": ["owner", "dispatcher"],
  // Location reporting: any authenticated seat, so a cleaner's phone can post.
  "POST /staff/location": ["owner", "dispatcher", "cleaner"],
  // Schedule: everyone signed in; a cleaner's view is scoped to their own jobs.
  "GET /schedule": ["owner", "dispatcher", "cleaner"],
};

/**
 * Routes that are reachable without a session by design. Anything the live
 * router exposes must be here or in MATRIX — nowhere else.
 */
const PUBLIC_ROUTES = new Set<string>([
  "GET /healthz",
  // The customer's bearer-token quote link.
  "GET /quote/:token",
  "POST /quote/:token/pay",
  "POST /quote/:token/payment/refresh",
  "POST /quote/:token/approve",
  // OAuth redirect target — Jobber calls it, not a signed-in user.
  "GET /company/jobber/callback",
]);

// An id that no seeded row uses, so allowed calls on :id routes 404 in the
// handler instead of touching data or external services.
const MISSING_ID = "999999999";

let server: http.Server;
let baseUrl: string;

let companyAId: number;
let companyBId: number;
let cleanerSeatId: number;
let assignedBookingId: number;
let unassignedBookingId: number;
let otherCompanyBookingId: number;

async function call(
  method: string,
  path: string,
  opts: { as?: Role | null; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.as) headers["x-test-user"] = USERS[opts.as];
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  return fetch(`${baseUrl}/api${path.replace(/:(id|token)/g, MISSING_ID)}`, {
    method,
    headers,
    body,
  });
}

beforeAll(async () => {
  const [companyA] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: USERS.owner,
      name: `AuthZ Test Co A ${runId}`,
    })
    .returning();
  const [companyB] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `test_authz_other_owner_${runId}`,
      name: `AuthZ Test Co B ${runId}`,
    })
    .returning();
  companyAId = companyA!.id;
  companyBId = companyB!.id;

  const seats = await db
    .insert(teamMembersTable)
    .values([
      {
        companyId: companyAId,
        name: "Test Dispatcher",
        email: `dispatcher_${runId}@test.invalid`,
        role: "dispatcher",
        status: "active",
        clerkUserId: USERS.dispatcher,
      },
      {
        companyId: companyAId,
        name: "Test Cleaner",
        email: `cleaner_${runId}@test.invalid`,
        role: "cleaner",
        status: "active",
        clerkUserId: USERS.cleaner,
      },
    ])
    .returning();
  cleanerSeatId = seats.find((s) => s.role === "cleaner")!.id;

  const bookings = await db
    .insert(bookingsTable)
    .values([
      {
        companyId: companyAId,
        callId: null,
        customerName: "Assigned Customer",
        customerPhone: "+15550000001",
        service: "Deep clean",
        scheduledFor: new Date("2030-01-01T17:00:00Z"),
        status: "confirmed",
        quotedAmount: 250,
      },
      {
        companyId: companyAId,
        callId: null,
        customerName: "Unassigned Customer",
        customerPhone: "+15550000002",
        service: "Move-out clean",
        scheduledFor: new Date("2030-01-02T17:00:00Z"),
        status: "pending",
      },
      {
        companyId: companyBId,
        callId: null,
        customerName: "Other Company Customer",
        customerPhone: "+15550000003",
        service: "Standard clean",
        scheduledFor: new Date("2030-01-03T17:00:00Z"),
        status: "pending",
      },
    ])
    .returning();
  assignedBookingId = bookings[0]!.id;
  unassignedBookingId = bookings[1]!.id;
  otherCompanyBookingId = bookings[2]!.id;

  await db.insert(bookingAssignmentsTable).values({
    bookingId: assignedBookingId,
    teamMemberId: cleanerSeatId,
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
  const companyIds = [companyAId, companyBId].filter((id) => id != null);
  if (companyIds.length > 0) {
    const bookings = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(inArray(bookingsTable.companyId, companyIds));
    const bookingIds = bookings.map((b) => b.id);
    if (bookingIds.length > 0) {
      await db
        .delete(bookingAssignmentsTable)
        .where(inArray(bookingAssignmentsTable.bookingId, bookingIds));
    }
    await db
      .delete(activityTable)
      .where(inArray(activityTable.companyId, companyIds));
    await db
      .delete(bookingsTable)
      .where(inArray(bookingsTable.companyId, companyIds));
    // POST /calls/simulate is exercised as owner/dispatcher and really
    // inserts a call row.
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

/** Every route the live router actually serves, as "METHOD /path" strings. */
function liveRoutes(): Set<string> {
  const found = new Set<string>();
  type Layer = {
    route?: { path: string | string[]; methods: Record<string, boolean> };
    name?: string;
    handle?: { stack?: Layer[] };
  };
  const walk = (layers: Layer[]) => {
    for (const layer of layers) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path)
          ? layer.route.path
          : [layer.route.path];
        for (const [method, on] of Object.entries(layer.route.methods)) {
          if (!on) continue;
          for (const p of paths) found.add(`${method.toUpperCase()} ${p}`);
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  walk((router as unknown as { stack: Layer[] }).stack);
  return found;
}

describe("route coverage", () => {
  it("every live route is accounted for in the matrix or the public list — a new unguarded route fails here", () => {
    const live = liveRoutes();
    const known = new Set([...Object.keys(MATRIX), ...PUBLIC_ROUTES]);

    const unaccounted = [...live].filter((r) => !known.has(r));
    expect(
      unaccounted,
      `New route(s) found with no authorization expectation. Add each to the ` +
        `MATRIX in authorization.test.ts with the exact roles allowed (and a ` +
        `requireRole guard in the route), or to PUBLIC_ROUTES if it is truly ` +
        `unauthenticated: ${unaccounted.join(", ")}`,
    ).toEqual([]);

    const stale = [...Object.keys(MATRIX)].filter((r) => !live.has(r));
    expect(
      stale,
      `Matrix mentions route(s) the router no longer serves: ${stale.join(", ")}`,
    ).toEqual([]);
  });
});

describe("authentication", () => {
  it.each(Object.keys(MATRIX))(
    "%s rejects a signed-out caller",
    async (key) => {
      const [method, path] = key.split(" ") as [string, string];
      const res = await call(method, path, { as: null });
      expect(res.status).toBe(401);
    },
  );
});

describe("role matrix", () => {
  for (const [key, allowed] of Object.entries(MATRIX)) {
    const [method, path] = key.split(" ") as [string, string];
    for (const role of ROLES) {
      // fetch() refuses a GET with a body, and these requests only need to
      // prove what the guard does, so bodies go on mutating methods only.
      const body = method === "GET" ? undefined : {};
      if (allowed.includes(role)) {
        it(`${key} lets a ${role} past the guard`, async () => {
          const res = await call(method, path, { as: role, body });
          // Allowed means the role guard passed; the handler may still 400/404
          // on the deliberately-bogus id or empty body.
          expect(res.status).not.toBe(401);
          expect(res.status).not.toBe(403);
        });
      } else {
        it(`${key} blocks a ${role} with 403`, async () => {
          const res = await call(method, path, { as: role, body });
          expect(res.status).toBe(403);
        });
      }
    }
  }
});

describe("cleaner booking scope", () => {
  it("a cleaner sees only the bookings they are assigned to", async () => {
    const res = await call("GET", "/bookings", { as: "cleaner" });
    expect(res.status).toBe(200);
    const bookings = (await res.json()) as Array<{ id: number }>;
    expect(bookings.map((b) => b.id)).toEqual([assignedBookingId]);
  });

  it("owner and dispatcher see the whole company's bookings — and never another company's", async () => {
    for (const role of ["owner", "dispatcher"] as const) {
      const res = await call("GET", "/bookings", { as: role });
      expect(res.status).toBe(200);
      const ids = ((await res.json()) as Array<{ id: number }>).map(
        (b) => b.id,
      );
      expect(ids).toContain(assignedBookingId);
      expect(ids).toContain(unassignedBookingId);
      expect(ids).not.toContain(otherCompanyBookingId);
    }
  });

  it("a cleaner can update the status of their own job", async () => {
    const res = await call("PATCH", `/bookings/${assignedBookingId}`, {
      as: "cleaner",
      body: { status: "completed" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("completed");
  });

  it("a cleaner cannot change anything except status, even on their own job", async () => {
    for (const body of [
      { quotedAmount: 1 },
      { status: "completed", quotedAmount: 1 },
      { customerPhone: "+15559999999" },
      { scheduledFor: "2030-06-01T17:00:00Z" },
    ]) {
      const res = await call("PATCH", `/bookings/${assignedBookingId}`, {
        as: "cleaner",
        body,
      });
      expect(res.status, JSON.stringify(body)).toBe(403);
    }
  });

  it("a cleaner cannot touch a job they are not assigned to", async () => {
    const res = await call("PATCH", `/bookings/${unassignedBookingId}`, {
      as: "cleaner",
      body: { status: "completed" },
    });
    expect(res.status).toBe(404);
  });

  it("a cleaner cannot touch another company's job — it does not even exist for them", async () => {
    const res = await call("PATCH", `/bookings/${otherCompanyBookingId}`, {
      as: "cleaner",
      body: { status: "completed" },
    });
    expect(res.status).toBe(404);
  });

  it("a cleaner cannot read another customer's quote via quote-preview", async () => {
    const res = await call(
      "GET",
      `/bookings/${unassignedBookingId}/quote-preview`,
      { as: "cleaner" },
    );
    expect(res.status).toBe(403);
  });
});

describe("dispatcher team boundary", () => {
  it("a dispatcher may list the team but not invite", async () => {
    const list = await call("GET", "/team", { as: "dispatcher" });
    expect(list.status).toBe(200);

    const invite = await call("POST", "/team", {
      as: "dispatcher",
      body: {
        name: "Sneaky Invite",
        email: `sneaky_${runId}@test.invalid`,
        role: "dispatcher",
      },
    });
    expect(invite.status).toBe(403);
  });

  it("a dispatcher may not remove team members", async () => {
    const res = await call("DELETE", `/team/${cleanerSeatId}`, {
      as: "dispatcher",
    });
    expect(res.status).toBe(403);
  });
});
