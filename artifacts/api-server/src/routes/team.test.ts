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
// can close over the same spies the tests assert on.
const { createInvitation, deleteUser, revokeInvitation } = vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
  return {
    createInvitation: vi.fn(async () => ({ id: "inv_test" })),
    deleteUser: vi.fn(async () => ({})),
    revokeInvitation: vi.fn(async () => ({})),
  };
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
      deleteUser,
    },
    invitations: {
      createInvitation,
      revokeInvitation,
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
  pendingTextsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
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
  opts: {
    as?: keyof typeof USERS | null;
    /** A caller who holds no seat yet — a sign-up asking to be let in. */
    user?: string;
    body?: unknown;
  } = {},
): Promise<JsonResponse> {
  const headers: Record<string, string> = {};
  if (opts.as) headers["x-test-user"] = USERS[opts.as];
  else if (opts.user) headers["x-test-user"] = opts.user;
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
  // Join-request flows queue texts that stay pending in tests (no platform
  // Quo key), which would block the company delete below.
  await db
    .delete(pendingTextsTable)
    .where(eq(pendingTextsTable.companyId, companyId));
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

describe("schedule colours", () => {
  it("are saved, changed and cleared back to automatic", async () => {
    const created = await (
      await call("POST", "/team", {
        as: "owner",
        body: { name: "Colour Cara", role: "cleaner", color: "#34D399" },
      })
    ).json();
    // Stored the way the schedule reads it, whatever case it arrived in.
    expect(created.color).toBe("#34d399");

    const changed = await (
      await call("PATCH", `/team/${created.id}`, {
        as: "owner",
        body: { color: "#60a5fa" },
      })
    ).json();
    expect(changed.color).toBe("#60a5fa");

    // Null is a real value here: the card goes back to the automatic hue.
    const cleared = await (
      await call("PATCH", `/team/${created.id}`, {
        as: "owner",
        body: { color: null },
      })
    ).json();
    expect(cleared.color).toBeNull();
  });

  it("never store anything that isn't a plain hex colour", async () => {
    const created = await (
      await call("POST", "/team", {
        as: "owner",
        body: {
          name: "Sneaky Sam",
          role: "cleaner",
          color: "javascript:alert(1)",
        },
      })
    ).json();
    expect(created.color).toBeNull();

    const patched = await (
      await call("PATCH", `/team/${created.id}`, {
        as: "owner",
        body: { color: "red; background:url(x)" },
      })
    ).json();
    expect(patched.color).toBeNull();
  });
});

describe("job titles", () => {
  it("replace the standard wording without touching what anyone may do", async () => {
    const saved = await call("PATCH", `/team/${cleanerSeatId}`, {
      as: "owner",
      body: { title: "Site Supervisor" },
    });
    expect(saved.status).toBe(200);
    const card = await saved.json();
    expect(card.title).toBe("Site Supervisor");
    // The wording every screen prints follows the title...
    expect(card.roleLabel).toBe("Site Supervisor");
    // ...while the permission level underneath is untouched. This is the
    // whole point: a job title is words, never access.
    expect(card.role).toBe("cleaner");

    const [row] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, cleanerSeatId));
    expect(row!.role).toBe("cleaner");
    expect(row!.title).toBe("Site Supervisor");
  });

  it("go back to the standard wording when cleared", async () => {
    await call("PATCH", `/team/${cleanerSeatId}`, {
      as: "owner",
      body: { title: "Window Tech", isLead: true },
    });

    const cleared = await call("PATCH", `/team/${cleanerSeatId}`, {
      as: "owner",
      body: { title: null },
    });
    expect(cleared.status).toBe(200);
    const card = await cleared.json();
    expect(card.title).toBeNull();
    expect(card.roleLabel).toBe("Lead Cleaner");

    // Blank and whitespace mean the same thing as null, never a title of "".
    const blanked = await call("PATCH", `/team/${cleanerSeatId}`, {
      as: "owner",
      body: { title: "   " },
    });
    expect((await blanked.json()).title).toBeNull();

    await call("PATCH", `/team/${cleanerSeatId}`, {
      as: "owner",
      body: { isLead: false },
    });
  });

  it("can be given by a dispatcher, who still may not hand out a role", async () => {
    const titled = await call("PATCH", `/team/${cleanerSeatId}`, {
      as: "dispatcher",
      body: { title: "Crew Lead" },
    });
    expect(titled.status).toBe(200);
    expect((await titled.json()).roleLabel).toBe("Crew Lead");

    const elevated = await call("PATCH", `/team/${cleanerSeatId}`, {
      as: "dispatcher",
      body: { role: "dispatcher" },
    });
    expect(elevated.status).toBe(403);

    await call("PATCH", `/team/${cleanerSeatId}`, {
      as: "owner",
      body: { title: null },
    });
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

describe("live-call dispatching switch", () => {
  it("the owner can hand it to a dispatcher, and take it back", async () => {
    const created = await (
      await call("POST", "/team", {
        as: "owner",
        body: { name: "Phones Pat", role: "dispatcher" },
      })
    ).json();
    expect(created.liveCallDispatching).toBe(false);

    const granted = await call("PATCH", `/team/${created.id}`, {
      as: "owner",
      body: { liveCallDispatching: true },
    });
    expect(granted.status).toBe(200);
    expect((await granted.json()).liveCallDispatching).toBe(true);

    const revoked = await call("PATCH", `/team/${created.id}`, {
      as: "owner",
      body: { liveCallDispatching: false },
    });
    expect(revoked.status).toBe(200);
    expect((await revoked.json()).liveCallDispatching).toBe(false);
  });

  it("a dispatcher cannot flip it — not even on their own card", async () => {
    const [self] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.clerkUserId, USERS.dispatcher));
    const res = await call("PATCH", `/team/${self!.id}`, {
      as: "dispatcher",
      body: { liveCallDispatching: true },
    });
    expect(res.status).toBe(403);
    const [row] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, self!.id));
    expect(row!.liveCallDispatching).toBe(false);
  });

  it("only a dispatcher card can carry it — a cleaner is refused, not silently ignored", async () => {
    const res = await call("PATCH", `/team/${cleanerSeatId}`, {
      as: "owner",
      body: { liveCallDispatching: true },
    });
    expect(res.status).toBe(400);
  });

  it("promoting to dispatcher and granting in one save works", async () => {
    const created = await (
      await call("POST", "/team", {
        as: "owner",
        body: { name: "Promoted Priya", role: "cleaner" },
      })
    ).json();
    const res = await call("PATCH", `/team/${created.id}`, {
      as: "owner",
      body: { role: "dispatcher", liveCallDispatching: true },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).liveCallDispatching).toBe(true);
  });

  it("moving a card off the dispatcher role clears the grant", async () => {
    const created = await (
      await call("POST", "/team", {
        as: "owner",
        body: { name: "Demoted Dev", role: "dispatcher" },
      })
    ).json();
    await call("PATCH", `/team/${created.id}`, {
      as: "owner",
      body: { liveCallDispatching: true },
    });
    const demoted = await call("PATCH", `/team/${created.id}`, {
      as: "owner",
      body: { role: "cleaner" },
    });
    expect(demoted.status).toBe(200);
    expect((await demoted.json()).liveCallDispatching).toBe(false);

    // A later promotion starts from "off" rather than resurrecting the grant.
    const repromoted = await call("PATCH", `/team/${created.id}`, {
      as: "owner",
      body: { role: "dispatcher" },
    });
    expect((await repromoted.json()).liveCallDispatching).toBe(false);
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

  it("a cleaner may fix the name on their own card, and nothing else", async () => {
    const renamed = await call("PATCH", `/team/${cleanerSeatId}`, {
      as: "cleaner",
      body: { name: "Cass Corrected" },
    });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).name).toBe("Cass Corrected");

    // Every other field on their own card stays out of reach — alone or
    // smuggled in beside a legitimate name change.
    for (const body of [
      { phone: "555-0777" },
      { role: "dispatcher" },
      { isLead: true },
      { title: "Site Supervisor" },
      { active: false },
      { color: "#123456" },
      { email: `elevated_${runId}@test.invalid` },
      { name: "Cass Again", phone: "555-0778" },
    ]) {
      const res = await call("PATCH", `/team/${cleanerSeatId}`, {
        as: "cleaner",
        body,
      });
      expect(res.status, JSON.stringify(body)).toBe(403);
    }

    const [row] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, cleanerSeatId));
    expect(row!.name).toBe("Cass Corrected");
    expect(row!.role).toBe("cleaner");
    expect(row!.phone).toBeNull();
  });

  it("a cleaner may not rename anyone else's card", async () => {
    const created = await (
      await call("POST", "/team", {
        as: "owner",
        body: { name: "Untouched Uma", role: "cleaner" },
      })
    ).json();

    const res = await call("PATCH", `/team/${created.id}`, {
      as: "cleaner",
      body: { name: "Renamed By A Peer" },
    });
    expect(res.status).toBe(403);

    const [row] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, created.id));
    expect(row!.name).toBe("Untouched Uma");
  });

  it("a cleaner sees the roster but never the applicant queue", async () => {
    const [applicant] = await db
      .insert(teamMembersTable)
      .values({
        companyId,
        name: "Waiting Wanda",
        role: "cleaner",
        status: "pending",
        active: false,
      })
      .returning();

    const res = await call("GET", "/team", { as: "cleaner" });
    expect(res.status).toBe(200);
    const members = await res.json();
    expect(members.some((m: { id: number }) => m.id === cleanerSeatId)).toBe(
      true,
    );
    expect(members.some((m: { id: number }) => m.id === applicant!.id)).toBe(
      false,
    );
    // Where a teammate lives is not crew-browsable: home addresses and their
    // map pins are stripped from every card a cleaner receives.
    for (const m of members) {
      expect(m.homeAddress).toBeNull();
      expect(m.homeLat).toBeNull();
      expect(m.homeLng).toBeNull();
    }

    // The same queue IS visible to whoever can act on it.
    const asOwner = await (await call("GET", "/team", { as: "owner" })).json();
    expect(asOwner.some((m: { id: number }) => m.id === applicant!.id)).toBe(
      true,
    );

    await db
      .delete(teamMembersTable)
      .where(eq(teamMembersTable.id, applicant!.id));
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

  it("lets the owner set the address on their own card without inviting themselves", async () => {
    // The owner's own seat is a card on the roster like any other, but it is
    // never claimed by a login — the company row is what makes them the owner.
    const [ownerSeat] = await db
      .insert(teamMembersTable)
      .values({
        companyId,
        name: "The Owner",
        email: `ownerseat_${runId}@test.invalid`,
        role: "owner",
        status: "active",
      })
      .returning();
    createInvitation.mockClear();

    const updated = await (
      await call("PATCH", `/team/${ownerSeat!.id}`, {
        as: "owner",
        body: { email: `support_${runId}@test.invalid` },
      })
    ).json();

    expect(updated.email).toBe(`support_${runId}@test.invalid`);
    // No sign-up link, and their own card must not read as though their
    // access were pending.
    expect(createInvitation).not.toHaveBeenCalled();
    expect(updated.status).not.toBe("invited");
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

/**
 * Signing yourself up.
 *
 * The mirror image of an invite, and the dangerous direction: anyone who knows
 * the code can create a request, so the whole safety of the feature rests on a
 * pending seat granting absolutely nothing until somebody approves it.
 */
describe("joining with a code", () => {
  const applicant = `staff_applicant_${runId}`;
  const stranger = `staff_stranger_${runId}`;

  async function joinCode(): Promise<string> {
    const res = await call("GET", "/team/join-code", { as: "owner" });
    expect(res.status).toBe(200);
    return (await res.json()).joinCode as string;
  }

  it("gives the owner a code, and the same one every time", async () => {
    const first = await joinCode();
    expect(first).toMatch(/^[A-Z0-9]{6}$/);
    expect(await joinCode()).toBe(first);
  });

  it("lands a sign-up on the Staff page without letting them in", async () => {
    const code = await joinCode();

    const created = await call("POST", "/team/join-requests", {
      as: null,
      body: { joinCode: code, name: "Applicant Amy", phone: "555-0199" },
      user: applicant,
    });
    expect(created.status).toBe(201);
    expect((await created.json()).companyName).toContain("Staff Co");

    // Nothing is open to them yet — not even the roster they asked to be on.
    const roster = await call("GET", "/team", { as: null, user: applicant });
    expect(roster.status).toBe(403);

    // …but the app can tell them what they're waiting for.
    const me = await (
      await call("GET", "/me", { as: null, user: applicant })
    ).json();
    expect(me.companyName).toBe("");
    expect(me.pendingCompanyName).toContain("Staff Co");

    // The owner sees the request, marked as waiting and off the roster.
    const team = await (await call("GET", "/team", { as: "owner" })).json();
    const request = team.find((m: any) => m.name === "Applicant Amy");
    expect(request.status).toBe("pending");
    expect(request.active).toBe(false);
    expect(request.phone).toBe("555-0199");
  });

  it("refuses a code that isn't anybody's", async () => {
    const res = await call("POST", "/team/join-requests", {
      as: null,
      body: { joinCode: "ZZZZZZ", name: "Nobody Ned" },
      user: stranger,
    });
    expect(res.status).toBe(404);
  });

  it("won't let a dispatcher wave someone in as another dispatcher", async () => {
    const team = await (await call("GET", "/team", { as: "owner" })).json();
    const pending = team.find((m: any) => m.status === "pending");

    const asDispatcher = await call(
      "POST",
      `/team/${pending.id}/approve`,
      // A dispatcher approving a dispatcher would quietly widen who can hand
      // out access, so it stays with the owner.
      { as: "dispatcher", body: { role: "dispatcher" } },
    );
    expect(asDispatcher.status).toBe(403);

    const asCleaner = await call("POST", `/team/${pending.id}/approve`, {
      as: "dispatcher",
      body: { role: "cleaner", isLead: true },
    });
    expect(asCleaner.status).toBe(200);
    const approved = await asCleaner.json();
    expect(approved.status).toBe("active");
    expect(approved.active).toBe(true);
    expect(approved.role).toBe("cleaner");
    expect(approved.isLead).toBe(true);

    // Approving is what turns the key: they now hold a real seat, and nothing
    // is outstanding.
    const me = await (
      await call("GET", "/me", { as: null, user: applicant })
    ).json();
    expect(me.role).toBe("cleaner");
    expect(me.companyName).toContain("Staff Co");
    expect(me.pendingCompanyName).toBe("");
  });

  it("won't approve the same request twice", async () => {
    const team = await (await call("GET", "/team", { as: "owner" })).json();
    const amy = team.find((m: any) => m.name === "Applicant Amy");
    const again = await call("POST", `/team/${amy.id}/approve`, {
      as: "owner",
      body: { role: "dispatcher" },
    });
    expect(again.status).toBe(404);

    // And the seat they already hold is untouched.
    const [row] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, amy.id));
    expect(row!.role).toBe("cleaner");
  });

  it("declining removes the request, and only a pending one", async () => {
    const code = await joinCode();
    const declinable = `staff_declined_${runId}`;
    await call("POST", "/team/join-requests", {
      as: null,
      body: { joinCode: code, name: "Declined Dee" },
      user: declinable,
    });

    const team = await (await call("GET", "/team", { as: "owner" })).json();
    const dee = team.find((m: any) => m.name === "Declined Dee");
    const res = await call("POST", `/team/${dee.id}/decline`, { as: "owner" });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    const after = await (await call("GET", "/team", { as: "owner" })).json();
    expect(after.find((m: any) => m.name === "Declined Dee")).toBeUndefined();

    // Decline must never become a second way to delete a working seat.
    const onWorkingSeat = await call("POST", `/team/${cleanerSeatId}/decline`, {
      as: "owner",
    });
    expect((await onWorkingSeat.json()).ok).toBe(false);
    const [stillThere] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, cleanerSeatId));
    expect(stillThere).toBeDefined();
  });

  it("lets someone withdraw a request they sent by mistake", async () => {
    const code = await joinCode();
    const mistaken = `staff_mistaken_${runId}`;
    await call("POST", "/team/join-requests", {
      as: null,
      body: { joinCode: code, name: "Mistaken Mo" },
      user: mistaken,
    });

    const withdrawn = await call("DELETE", "/team/join-requests", {
      as: null,
      user: mistaken,
    });
    expect((await withdrawn.json()).ok).toBe(true);

    const me = await (
      await call("GET", "/me", { as: null, user: mistaken })
    ).json();
    expect(me.pendingCompanyName).toBe("");
  });

  it("survives two managers acting on the same request at once", async () => {
    const code = await joinCode();
    const raced = `staff_raced_${runId}`;
    await call("POST", "/team/join-requests", {
      as: null,
      body: { joinCode: code, name: "Raced Rae" },
      user: raced,
    });
    const team = await (await call("GET", "/team", { as: "owner" })).json();
    const rae = team.find((m: any) => m.name === "Raced Rae");

    // Owner approving while a dispatcher declines: exactly one may win, and
    // neither may blow up or record an outcome that didn't happen.
    const [approve, decline] = await Promise.all([
      call("POST", `/team/${rae.id}/approve`, {
        as: "owner",
        body: { role: "dispatcher" },
      }),
      call("POST", `/team/${rae.id}/decline`, { as: "dispatcher" }),
    ]);

    expect(approve.status).not.toBe(500);
    const approved = approve.status === 200;
    const declined = (await decline.json()).ok === true;
    expect(approved === declined).toBe(false);

    const [row] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, rae.id));
    if (approved) {
      expect(row!.status).toBe("active");
    } else {
      expect(row).toBeUndefined();
    }

    // The activity feed has to match what actually happened.
    const notes = await db
      .select()
      .from(activityTable)
      .where(eq(activityTable.companyId, companyId));
    const about = notes.filter((n) => n.message.includes("Raced Rae"));
    expect(
      about.some((n) =>
        approved
          ? n.message.includes("approved")
          : n.message.includes("declined"),
      ),
    ).toBe(true);
    expect(
      about.some((n) =>
        approved
          ? n.message.includes("declined")
          : n.message.includes("was approved"),
      ),
    ).toBe(false);
  });

  it("won't let someone already waiting ask a second time", async () => {
    const code = await joinCode();
    const twice = `staff_twice_${runId}`;
    const first = await call("POST", "/team/join-requests", {
      as: null,
      body: { joinCode: code, name: "Twice Tia" },
      user: twice,
    });
    expect(first.status).toBe(201);

    const second = await call("POST", "/team/join-requests", {
      as: null,
      body: { joinCode: code, name: "Twice Tia" },
      user: twice,
    });
    expect(second.status).toBe(409);
  });

  it("won't let a waiting applicant create a company of their own", async () => {
    const waiting = `staff_waiting_${runId}`;
    const code = await joinCode();
    await call("POST", "/team/join-requests", {
      as: null,
      body: { joinCode: code, name: "Waiting Wes" },
      user: waiting,
    });

    // A waiting applicant resolves as the least-privileged caller there is, so
    // they can't quietly become the owner of an empty second company while
    // their real workplace still shows a request nobody has actioned.
    const res = await call("POST", "/company", {
      as: null,
      user: waiting,
      body: { name: "Accidental Second Co" },
    });
    expect(res.status).toBe(403);
  });

  it("names the owner's roster card from their login profile, not 'You'", async () => {
    // The card is what teammates see on the map and in chat, so creation
    // stamps it with the Clerk profile name (the mock says "Test User").
    const freshOwner = `staff_fresh_owner_${runId}`;
    const res = await call("POST", "/company", {
      as: null,
      user: freshOwner,
      body: { name: "Named Owner Co" },
    });
    expect(res.status).toBe(201);
    const { id } = await res.json();

    const [seat] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.companyId, id));
    expect(seat?.role).toBe("owner");
    expect(seat?.name).toBe("Test User");

    // This company is outside the suite's afterAll cleanup — remove it here.
    await db.delete(teamMembersTable).where(eq(teamMembersTable.companyId, id));
    await db.delete(companiesTable).where(eq(companiesTable.id, id));
  });

  it("won't let a dispatcher retire the code", async () => {
    const before = await joinCode();
    const res = await call("POST", "/team/join-code/rotate", {
      as: "dispatcher",
    });
    expect(res.status).toBe(403);
    expect(await joinCode()).toBe(before);
  });

  it("lets the owner retire the code without touching crew or requests", async () => {
    const oldCode = await joinCode();
    const teamBefore = await (
      await call("GET", "/team", { as: "owner" })
    ).json();
    expect(teamBefore.length).toBeGreaterThan(0);

    const res = await call("POST", "/team/join-code/rotate", { as: "owner" });
    expect(res.status).toBe(200);
    const { joinCode: newCode } = await res.json();
    expect(newCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(newCode).not.toBe(oldCode);

    // The GET now hands out the replacement, not the retired code.
    expect(await joinCode()).toBe(newCode);

    // The old code stops matching anyone.
    const stale = await call("POST", "/team/join-requests", {
      as: null,
      body: { joinCode: oldCode, name: "Late Lena" },
      user: `staff_late_${runId}`,
    });
    expect(stale.status).toBe(404);

    // The new one works.
    const fresh = await call("POST", "/team/join-requests", {
      as: null,
      body: { joinCode: newCode, name: "Fresh Fran" },
      user: `staff_fresh_${runId}`,
    });
    expect(fresh.status).toBe(201);

    // Nobody already on the roster — or already waiting — was disturbed.
    const teamAfter = await (
      await call("GET", "/team", { as: "owner" })
    ).json();
    for (const m of teamBefore) {
      const still = teamAfter.find((a: any) => a.id === m.id);
      expect(still).toBeDefined();
      expect(still.status).toBe(m.status);
    }

    // And there's a record of the change in the activity feed.
    const notes = await db
      .select()
      .from(activityTable)
      .where(eq(activityTable.companyId, companyId));
    expect(
      notes.some(
        (n) =>
          n.type === "join_code_changed" &&
          n.message.includes("join code was changed"),
      ),
    ).toBe(true);
  });
});

/**
 * The boss signs in from a phone, a tablet and the desk PC, and each of those
 * is a separate account with its own card. Making those cards owners is what
 * gives him the map at any hour and dispatch's full run of the app from
 * whichever device is in his hand.
 */
describe("more than one owner", () => {
  const tabletUser = `staff_tablet_${runId}`;

  it.skip("promotes a device card, drops the lead label, and pins its tracking on", async () => {
    const card = await (
      await call("POST", "/team", {
        as: "owner",
        body: { name: "Boss iPad", role: "cleaner", isLead: true },
      })
    ).json();

    const promoted = await call("PATCH", `/team/${card.id}`, {
      as: "owner",
      body: { role: "owner" },
    });
    expect(promoted.status).toBe(200);
    const body = await promoted.json();
    expect(body.role).toBe("owner");
    // "Lead Cleaner" is a label for a crew member, never for the boss.
    expect(body.isLead).toBe(false);

    // An owner's device is always on the map, so sharing can't be switched
    // off from underneath him.
    const off = await call("PUT", `/staff/tracking/${card.id}`, {
      as: "owner",
      body: { enabled: false },
    });
    expect(off.status).toBe(400);
  });

  it("won't let an owner sign away the card their own access rests on", async () => {
    const card = await (
      await call("POST", "/team", {
        as: "owner",
        body: { name: "Boss Tablet", role: "dispatcher" },
      })
    ).json();
    await call("PATCH", `/team/${card.id}`, {
      as: "owner",
      body: { role: "owner" },
    });
    // That card is now somebody's login.
    await db
      .update(teamMembersTable)
      .set({ clerkUserId: tabletUser })
      .where(eq(teamMembersTable.id, card.id));

    const selfDemote = await call("PATCH", `/team/${card.id}`, {
      user: tabletUser,
      body: { role: "dispatcher" },
    });
    expect(selfDemote.status).toBe(400);

    const selfRemove = await call("DELETE", `/team/${card.id}`, {
      user: tabletUser,
    });
    expect(selfRemove.status).toBe(400);

    // Still an owner after both attempts.
    const [row] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, card.id));
    expect(row!.role).toBe("owner");

    // It is a real owner, though: it can hand the role to the next device…
    const phone = await (
      await call("POST", "/team", {
        user: tabletUser,
        body: { name: "Boss Android", role: "cleaner" },
      })
    ).json();
    const second = await call("PATCH", `/team/${phone.id}`, {
      user: tabletUser,
      body: { role: "owner" },
    });
    expect(second.status).toBe(200);

    // …and the account that owns the company can still undo any of it,
    // including its own card, so nothing here is a one-way door.
    const undo = await call("PATCH", `/team/${card.id}`, {
      as: "owner",
      body: { role: "dispatcher" },
    });
    expect(undo.status).toBe(200);
    expect((await undo.json()).role).toBe("dispatcher");
  });

  it("is never something a dispatcher can hand out", async () => {
    const card = await (
      await call("POST", "/team", {
        as: "owner",
        body: { name: "Ambitious Amy", role: "cleaner" },
      })
    ).json();

    const attempt = await call("PATCH", `/team/${card.id}`, {
      as: "dispatcher",
      body: { role: "owner" },
    });
    expect(attempt.status).toBe(403);

    const [row] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, card.id));
    expect(row!.role).toBe("cleaner");
  });
});

/**
 * Full row removal (DELETE /team/:id).
 *
 * This permanently erases the roster card.  When the member has an outstanding
 * invitation, the emailed sign-up link must also be revoked so access truly
 * ends — not just the DB row.  A future refactor that drops the revocation
 * call would go undetected without an explicit assertion here.
 */
describe("removing a team member (DELETE /team/:id)", () => {
  it("revokes the Clerk invitation and deletes the row when the member has a pending invite", async () => {
    // Pre-clean any stale row left by a prior crashed run that shared this
    // runId (possible when vitest reuses a cached module in the same worker).
    await db
      .delete(teamMembersTable)
      .where(
        and(
          eq(teamMembersTable.companyId, companyId),
          eq(teamMembersTable.email, `rita_${runId}@test.invalid`),
        ),
      );

    const [member] = await db
      .insert(teamMembersTable)
      .values({
        companyId,
        name: "Removed Rita",
        email: `rita_${runId}@test.invalid`,
        role: "cleaner",
        status: "invited",
        clerkInvitationId: `inv_rita_${runId}`,
      })
      .returning();

    revokeInvitation.mockClear();

    try {
      const res = await call("DELETE", `/team/${member!.id}`, { as: "owner" });
      expect(res.status).toBe(204);

      // The sign-up link must be killed so the removed member can't still join.
      expect(revokeInvitation).toHaveBeenCalledWith(`inv_rita_${runId}`);

      // The row itself must be gone.
      const [row] = await db
        .select()
        .from(teamMembersTable)
        .where(eq(teamMembersTable.id, member!.id));
      expect(row).toBeUndefined();
    } finally {
      // Safety net: if the test fails before the route deletes the row, clean
      // it up here so the next run doesn't trip on a stale unique constraint.
      await db
        .delete(teamMembersTable)
        .where(eq(teamMembersTable.id, member!.id));
    }
  });
});

/**
 * Revoking a staff login (DELETE /team/:id/account).
 *
 * The endpoint is the safety valve when a cleaner leaves: it clears the Clerk
 * credentials so the person can no longer sign in, but keeps the roster card
 * (name, phone, Jobber link, booking history) intact for the next hire.
 *
 * A future refactor must not be able to silently skip the Clerk delete, leave
 * stale DB columns, or let a non-owner reach this endpoint.
 */
describe("revoking a staff login (DELETE /team/:id/account)", () => {
  it("deletes the Clerk user, clears both id columns, and resets status to active", async () => {
    const [member] = await db
      .insert(teamMembersTable)
      .values({
        companyId,
        name: "Revoked Roz",
        email: `roz_${runId}@test.invalid`,
        role: "cleaner",
        status: "active",
        clerkUserId: `clerk_roz_${runId}`,
        clerkInvitationId: `inv_roz_${runId}`,
      })
      .returning();

    deleteUser.mockClear();
    revokeInvitation.mockClear();

    const res = await call("DELETE", `/team/${member!.id}/account`, {
      as: "owner",
    });
    expect(res.status).toBe(200);

    // Clerk user was removed — they can no longer sign in.
    expect(deleteUser).toHaveBeenCalledWith(`clerk_roz_${runId}`);
    // The outstanding invitation link was also revoked.
    expect(revokeInvitation).toHaveBeenCalledWith(`inv_roz_${runId}`);

    // Both id columns are cleared on the DB row.
    const [row] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, member!.id));
    expect(row!.clerkUserId).toBeNull();
    expect(row!.clerkInvitationId).toBeNull();
    // Status reverts to "active" (seat lives on, ready for a new invite).
    expect(row!.status).toBe("active");
  });

  it("revokes the invitation and clears the columns when there is no live user yet", async () => {
    // An invited-but-not-yet-signed-up staff member: invitation id set, no
    // Clerk user id yet.
    const [member] = await db
      .insert(teamMembersTable)
      .values({
        companyId,
        name: "Invited Only Ida",
        email: `ida_${runId}@test.invalid`,
        role: "cleaner",
        status: "invited",
        clerkInvitationId: `inv_ida_${runId}`,
      })
      .returning();

    deleteUser.mockClear();
    revokeInvitation.mockClear();

    const res = await call("DELETE", `/team/${member!.id}/account`, {
      as: "owner",
    });
    expect(res.status).toBe(200);

    // No Clerk user exists yet, so deleteUser must not be called.
    expect(deleteUser).not.toHaveBeenCalled();
    // The emailed sign-up link is revoked so it stops working.
    expect(revokeInvitation).toHaveBeenCalledWith(`inv_ida_${runId}`);

    const [row] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, member!.id));
    expect(row!.clerkInvitationId).toBeNull();
    expect(row!.clerkUserId).toBeNull();
    expect(row!.status).toBe("active");
  });

  it("completes silently when the row has no Clerk ids at all", async () => {
    // A staff member added without email — no invitation was sent, no login
    // was ever created. The endpoint must still return 200, not 500.
    const [member] = await db
      .insert(teamMembersTable)
      .values({
        companyId,
        name: "No Login Nell",
        role: "cleaner",
        status: "active",
      })
      .returning();

    deleteUser.mockClear();
    revokeInvitation.mockClear();

    const res = await call("DELETE", `/team/${member!.id}/account`, {
      as: "owner",
    });
    expect(res.status).toBe(200);

    // Nothing to revoke — neither Clerk call should fire.
    expect(deleteUser).not.toHaveBeenCalled();
    expect(revokeInvitation).not.toHaveBeenCalled();

    const [row] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, member!.id));
    expect(row!.clerkUserId).toBeNull();
    expect(row!.clerkInvitationId).toBeNull();
    expect(row!.status).toBe("active");
  });

  it("refuses the request when the caller is not an owner", async () => {
    // The endpoint is owner-only; a dispatcher must never be able to revoke
    // another person's login.
    const res = await call("DELETE", `/team/${cleanerSeatId}/account`, {
      as: "dispatcher",
    });
    expect(res.status).toBe(403);

    // The cleaner's login is untouched.
    const [row] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, cleanerSeatId));
    expect(row!.clerkUserId).toBe(USERS.cleaner);
  });

  it("refuses when a seat-based owner tries to revoke their own login", async () => {
    // The isSelfSeat guard compares the caller's teamMemberId against the
    // target seat's id. It only fires for seat-based callers (teamMemberId ≠
    // null). The company's ownerUserId path gives teamMemberId=null, so we
    // need a user who resolves via a team-member seat (clerkUserId match),
    // not via the company ownership row.
    const seatOwnerUser = `seat_owner_${runId}`;

    const [selfSeat] = await db
      .insert(teamMembersTable)
      .values({
        companyId,
        name: "Seat Owner Oz",
        email: `oz_${runId}@test.invalid`,
        role: "owner",
        status: "active",
        clerkUserId: seatOwnerUser,
      })
      .returning();

    deleteUser.mockClear();

    // Call as the seat-based owner — this user resolves via the seat row
    // (teamMemberId = selfSeat.id), so isSelfSeat returns true.
    const res = await call("DELETE", `/team/${selfSeat!.id}/account`, {
      user: seatOwnerUser,
    });
    expect(res.status).toBe(400);

    // Clerk must not have been asked to delete anything.
    expect(deleteUser).not.toHaveBeenCalled();

    // The clerkUserId must still be set — the owner's login is intact.
    const [row] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, selfSeat!.id));
    expect(row!.clerkUserId).toBe(seatOwnerUser);
  });
});
