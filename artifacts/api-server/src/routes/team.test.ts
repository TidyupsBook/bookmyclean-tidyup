/**
 * Staff roster integration tests.
 *
 * Same live-app-against-real-DB style as the other route tests: Clerk is the
 * only thing mocked (caller id via x-test-user, invitations stubbed).
 *
 * The point of most of these is that a cleaning crew is not a list of logins.
 * People without an email have to work everywhere a person works — the roster,
 * the spreadsheet, the map — and the things that decide who can sign in have
 * to stay locked to the owner while the rest of the card doesn't.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type http from "node:http";

// Hoisted so the module mock below — which runs before any top-level code —
// can close over the same spy the tests assert on.
const { createInvitation } = vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
  return { createInvitation: vi.fn(async () => ({ id: "inv_test" })) };
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
      // No existing accounts anywhere, so nothing is ever "blocked".
      getUserList: async () => ({ data: [] }),
    },
    invitations: {
      createInvitation,
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
  activityTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  setGeocoder,
  resetGeocoder,
  clearGeocodeCache,
} from "../services/geocode";

const runId = `${Date.now()}_${process.pid}`;
const USERS = {
  owner: `staff_owner_${runId}`,
  dispatcher: `staff_dispatcher_${runId}`,
  cleaner: `staff_cleaner_${runId}`,
};

let server: http.Server;
let baseUrl: string;
let companyId: number;
let cleanerSeatId: number;

/**
 * These tests assert on individual fields of the JSON, not on its shape, so
 * the body is deliberately untyped rather than restated as an interface that
 * would drift from the real one.
 */
type JsonResponse = Omit<Response, "json"> & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): Promise<any>;
};

async function call(
  method: string,
  path: string,
  opts: { as?: keyof typeof USERS | null; body?: unknown } = {},
): Promise<JsonResponse> {
  const headers: Record<string, string> = {};
  if (opts.as) headers["x-test-user"] = USERS[opts.as];
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  return fetch(`${baseUrl}/api${path}`, { method, headers, body });
}

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: USERS.owner,
      name: `Staff Co ${runId}`,
      timezone: "America/Toronto",
    })
    .returning();
  companyId = company!.id;

  const seats = await db
    .insert(teamMembersTable)
    .values([
      {
        companyId,
        name: "Dispatch Dana",
        email: `disp_${runId}@test.invalid`,
        role: "dispatcher",
        status: "active",
        clerkUserId: USERS.dispatcher,
      },
      {
        companyId,
        name: "Cleaner Cass",
        email: `cleaner_${runId}@test.invalid`,
        role: "cleaner",
        status: "active",
        clerkUserId: USERS.cleaner,
      },
    ])
    .returning();
  cleanerSeatId = seats.find((s) => s.clerkUserId === USERS.cleaner)!.id;

  // Every address resolves, so "did we geocode it" is what's under test rather
  // than whether Google happened to answer.
  clearGeocodeCache();
  setGeocoder(async (address: string) =>
    address.toLowerCase().includes("nowhere")
      ? null
      : { lat: 43.7, lng: -79.4 },
  );

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  resetGeocoder();
  clearGeocodeCache();
  await db.delete(activityTable).where(eq(activityTable.companyId, companyId));
  await db
    .delete(teamMembersTable)
    .where(eq(teamMembersTable.companyId, companyId));
  await db
    .delete(companiesTable)
    .where(inArray(companiesTable.id, [companyId]));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe("staff without an email", () => {
  it("can be added, and is never shown as waiting on an invite", async () => {
    createInvitation.mockClear();
    const res = await call("POST", "/team", {
      as: "owner",
      body: {
        name: "No Email Nina",
        role: "cleaner",
        phone: "555-0100",
        isLead: true,
      },
    });
    expect(res.status).toBe(201);
    const created = await res.json();

    expect(created.email).toBeNull();
    expect(created.phone).toBe("555-0100");
    expect(created.isLead).toBe(true);
    expect(created.active).toBe(true);
    // Nothing was sent, so nothing is outstanding.
    expect(createInvitation).not.toHaveBeenCalled();
    expect(created.inviteEmailSent).toBe(false);
    expect(created.hasLogin).toBe(false);
    expect(created.status).toBe("active");
  });

  it("lets two of them exist at once", async () => {
    const first = await call("POST", "/team", {
      as: "owner",
      body: { name: "Emailless One", role: "cleaner" },
    });
    const second = await call("POST", "/team", {
      as: "owner",
      body: { name: "Emailless Two", role: "cleaner" },
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });
});

describe("home addresses", () => {
  it("are geocoded on save so they can be pinned", async () => {
    const created = await (
      await call("POST", "/team", {
        as: "owner",
        body: {
          name: "Homebody Hal",
          role: "cleaner",
          homeAddress: `12 Elm St ${runId}`,
        },
      })
    ).json();
    expect(created.homeLat).toBeCloseTo(43.7);
    expect(created.homeLng).toBeCloseTo(-79.4);
  });

  it("still save the person when the address can't be found", async () => {
    const created = await (
      await call("POST", "/team", {
        as: "owner",
        body: {
          name: "Lost Lou",
          role: "cleaner",
          homeAddress: `Nowhere at all ${runId}`,
        },
      })
    ).json();
    expect(created.id).toBeGreaterThan(0);
    expect(created.homeAddress).toContain("Nowhere");
    expect(created.homeLat).toBeNull();
  });

  it("are re-located when edited, and cleared when removed", async () => {
    const created = await (
      await call("POST", "/team", {
        as: "owner",
        body: { name: "Mover Mo", role: "cleaner" },
      })
    ).json();
    expect(created.homeLat).toBeNull();

    const moved = await (
      await call("PATCH", `/team/${created.id}`, {
        as: "owner",
        body: { homeAddress: `99 New Rd ${runId}` },
      })
    ).json();
    expect(moved.homeLat).toBeCloseTo(43.7);

    const cleared = await (
      await call("PATCH", `/team/${created.id}`, {
        as: "owner",
        body: { homeAddress: "" },
      })
    ).json();
    expect(cleared.homeAddress).toBeNull();
    expect(cleared.homeLat).toBeNull();
  });
});

describe("who may change what", () => {
  it("a dispatcher may fix a phone number but not hand out a role", async () => {
    const created = await (
      await call("POST", "/team", {
        as: "owner",
        body: { name: "Patchy Pat", role: "cleaner" },
      })
    ).json();

    const phone = await call("PATCH", `/team/${created.id}`, {
      as: "dispatcher",
      body: { phone: "555-0199", active: false },
    });
    expect(phone.status).toBe(200);
    expect((await phone.json()).active).toBe(false);

    const promote = await call("PATCH", `/team/${created.id}`, {
      as: "dispatcher",
      body: { role: "dispatcher" },
    });
    expect(promote.status).toBe(403);

    const rewire = await call("PATCH", `/team/${created.id}`, {
      as: "dispatcher",
      body: { email: `sneaky_${runId}@test.invalid` },
    });
    expect(rewire.status).toBe(403);

    // And nothing actually moved.
    const [row] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, created.id));
    expect(row!.role).toBe("cleaner");
    expect(row!.email).toBeNull();
  });

  it("refuses to change the email of someone who has already signed in", async () => {
    const res = await call("PATCH", `/team/${cleanerSeatId}`, {
      as: "owner",
      body: { email: `newaddress_${runId}@test.invalid` },
    });
    expect(res.status).toBe(400);

    const [row] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, cleanerSeatId));
    expect(row!.email).toBe(`cleaner_${runId}@test.invalid`);
  });

  it("cannot reach another company's staff", async () => {
    const [other] = await db
      .insert(companiesTable)
      .values({
        ownerUserId: `staff_otherowner_${runId}`,
        name: `Other Co ${runId}`,
        timezone: "America/Toronto",
      })
      .returning();
    const [theirSeat] = await db
      .insert(teamMembersTable)
      .values({
        companyId: other!.id,
        name: "Their Cleaner",
        email: `theirs_${runId}@test.invalid`,
        role: "cleaner",
        status: "active",
      })
      .returning();

    const res = await call("PATCH", `/team/${theirSeat!.id}`, {
      as: "owner",
      body: { name: "Renamed By A Stranger" },
    });
    expect(res.status).toBe(404);

    const [row] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, theirSeat!.id));
    expect(row!.name).toBe("Their Cleaner");

    await db
      .delete(teamMembersTable)
      .where(eq(teamMembersTable.companyId, other!.id));
    await db.delete(companiesTable).where(eq(companiesTable.id, other!.id));
  });

  it("adding an email to someone who had none sends them an invite", async () => {
    const created = await (
      await call("POST", "/team", {
        as: "owner",
        body: { name: "Late Login Lee", role: "cleaner" },
      })
    ).json();
    createInvitation.mockClear();

    const updated = await (
      await call("PATCH", `/team/${created.id}`, {
        as: "owner",
        body: { email: `lee_${runId}@test.invalid` },
      })
    ).json();

    expect(createInvitation).toHaveBeenCalledTimes(1);
    expect(updated.email).toBe(`lee_${runId}@test.invalid`);
    expect(updated.inviteEmailSent).toBe(true);
    expect(updated.status).toBe("invited");
  });
});

describe("spreadsheet import", () => {
  it("adds new people, updates the ones already there, and reports bad rows", async () => {
    const existing = await (
      await call("POST", "/team", {
        as: "owner",
        body: {
          name: "Roundtrip Rita",
          role: "cleaner",
          email: `rita_${runId}@test.invalid`,
        },
      })
    ).json();
    createInvitation.mockClear();

    const res = await call("POST", "/team/import", {
      as: "owner",
      body: {
        members: [
          {
            name: "Roundtrip Rita",
            email: `rita_${runId}@test.invalid`,
            role: "cleaner",
            phone: "555-0123",
            isLead: true,
          },
          {
            name: "Fresh Face Fay",
            email: null,
            role: "cleaner",
            homeAddress: `7 Import Ave ${runId}`,
          },
          { name: "   ", role: "cleaner" },
        ],
      },
    });
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.added).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(1);

    // The existing person was edited in place, not cloned.
    const [rita] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, existing.id));
    expect(rita!.phone).toBe("555-0123");
    expect(rita!.isLead).toBe(true);

    // A bulk upload must never quietly email everyone in the file.
    expect(createInvitation).not.toHaveBeenCalled();
  });

  it("matches an emailed row by email only, never by name", async () => {
    // Someone on the roster with no address, and a spreadsheet row for a
    // different person who happens to share the name.
    const [nameless] = await db
      .insert(teamMembersTable)
      .values({
        companyId,
        name: `Twin Name ${runId}`,
        role: "cleaner",
        status: "active",
        phone: "555-ORIGINAL",
      })
      .returning();

    const result = await (
      await call("POST", "/team/import", {
        as: "owner",
        body: {
          members: [
            {
              name: `Twin Name ${runId}`,
              email: `twin_${runId}@test.invalid`,
              role: "cleaner",
              phone: "555-IMPOSTOR",
            },
          ],
        },
      })
    ).json();

    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);

    const [original] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, nameless!.id));
    expect(original!.phone).toBe("555-ORIGINAL");
  });

  it("reports a person listed twice instead of applying the last row", async () => {
    const result = await (
      await call("POST", "/team/import", {
        as: "owner",
        body: {
          members: [
            {
              name: "Double Dot",
              email: `double_${runId}@test.invalid`,
              role: "cleaner",
              phone: "111",
            },
            {
              name: "Double Dot",
              email: `double_${runId}@test.invalid`,
              role: "cleaner",
              phone: "222",
            },
          ],
        },
      })
    ).json();

    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors[0]).toContain("more than once");

    const rows = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.companyId, companyId));
    const doubles = rows.filter((r) => r.name === "Double Dot");
    expect(doubles).toHaveLength(1);
    expect(doubles[0]!.phone).toBe("111");
  });

  it("refuses a file far bigger than a cleaning crew", async () => {
    const res = await call("POST", "/team/import", {
      as: "owner",
      body: {
        members: Array.from({ length: 501 }, (_, i) => ({
          name: `Bulk ${i}`,
          role: "cleaner" as const,
        })),
      },
    });
    expect(res.status).toBe(400);
  });

  it("is refused to a dispatcher", async () => {
    const res = await call("POST", "/team/import", {
      as: "dispatcher",
      body: { members: [{ name: "Backdoor Bob", role: "dispatcher" }] },
    });
    expect(res.status).toBe(403);
  });
});
