/**
 * A seat held by a Clerk account that no longer exists.
 *
 * This happens two ways: the account was deleted, or the database was copied
 * between Clerk instances (a development dump restored into production) so
 * every stored user id was never valid there in the first place. Either way
 * the seat still reads as "claimed", the invite match skips it, and the real
 * person is dropped into onboarding on every sign-in — where the only thing
 * on offer is creating a second, empty company beside the one they belong to.
 *
 * These tests pin the release and, just as importantly, every case that must
 * NOT release one: a live holder, an unverified email, Clerk being
 * unreachable, and a record outside its recovery window. That last one is the
 * fence around the whole feature — a verified email proves who you are today,
 * not that you are the person who held the record, so recovery is scoped to
 * the stranded records and expires rather than standing open for anyone who
 * later acquires the address.
 */
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

type ClerkAccount = { emails: Array<{ address: string; verified: boolean }> };

const clerkAccounts = new Map<string, ClerkAccount>();
let clerkUnreachable = false;
/**
 * Ids whose lookup errors while the rest of Clerk answers normally — a rate
 * limit or a timeout on one request. This is the "indeterminate" case: we
 * cannot tell whether the holder is gone, which is different from knowing they
 * are still there.
 */
const clerkErroringIds = new Set<string>();

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUser: async (id: string) => {
        if (clerkUnreachable) throw new Error("clerk down");
        if (clerkErroringIds.has(id)) {
          throw Object.assign(new Error("Too Many Requests"), { status: 429 });
        }
        const account = clerkAccounts.get(id);
        if (!account) {
          // Shape matches Clerk's own not-found error.
          throw Object.assign(new Error("Not Found"), { status: 404 });
        }
        return {
          emailAddresses: account.emails.map((e) => ({
            emailAddress: e.address,
            verification: { status: e.verified ? "verified" : "unverified" },
          })),
          firstName: "Test",
          lastName: "User",
        };
      },
    },
  },
}));

import {
  db,
  pool,
  companiesTable,
  teamMembersTable,
  activityTable,
  bookingsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { resolveCaller, forgetDeniedCaller } from "./callerRole";

const runId = Math.random().toString(36).slice(2, 8);
const SEAT_EMAIL = `joseph_${runId}@test.invalid`;
const OWNER_EMAIL = `owner_${runId}@test.invalid`;
const GHOST_USER = `user_ghost_${runId}`;
const GHOST_OWNER = `user_ghostowner_${runId}`;
const LIVE_USER = `user_live_${runId}`;
const RETURNING_USER = `user_returning_${runId}`;
const RETURNING_OWNER = `user_returningowner_${runId}`;

/** Inside the recovery window — the state the stranded records are left in. */
const OPEN_WINDOW = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

let companyId: number;
let seatId: number;

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: GHOST_OWNER,
      ownerEmail: OWNER_EMAIL,
      ownerRecoveryUntil: OPEN_WINDOW,
      name: `Reclaim Co ${runId}`,
      timezone: "America/Edmonton",
    })
    .returning();
  companyId = company!.id;

  const [seat] = await db
    .insert(teamMembersTable)
    .values({
      companyId,
      name: "Joseph",
      email: SEAT_EMAIL,
      role: "dispatcher",
      status: "active",
      clerkUserId: GHOST_USER,
      recoveryUntil: OPEN_WINDOW,
    })
    .returning();
  seatId = seat!.id;
});

afterAll(async () => {
  await db.delete(activityTable).where(eq(activityTable.companyId, companyId));
  await db.delete(bookingsTable).where(eq(bookingsTable.companyId, companyId));
  await db
    .delete(teamMembersTable)
    .where(eq(teamMembersTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end();
});

beforeEach(async () => {
  clerkUnreachable = false;
  clerkErroringIds.clear();
  clerkAccounts.clear();
  forgetDeniedCaller();
  // Back to the broken state: the seat and the company are both held by
  // accounts Clerk no longer knows about, both inside their recovery window.
  await db
    .update(teamMembersTable)
    .set({
      clerkUserId: GHOST_USER,
      email: SEAT_EMAIL,
      recoveryUntil: OPEN_WINDOW,
    })
    .where(eq(teamMembersTable.id, seatId));
  await db
    .update(companiesTable)
    .set({
      ownerUserId: GHOST_OWNER,
      ownerEmail: OWNER_EMAIL,
      ownerRecoveryUntil: OPEN_WINDOW,
    })
    .where(eq(companiesTable.id, companyId));
});

describe("a seat held by a deleted Clerk account", () => {
  it("is released to the same verified email signing in again", async () => {
    clerkAccounts.set(RETURNING_USER, {
      emails: [{ address: SEAT_EMAIL, verified: true }],
    });

    const caller = await resolveCaller(RETURNING_USER);

    // The whole point: they land in their real company as a dispatcher, not
    // in onboarding as a would-be owner of nothing.
    expect(caller.role).toBe("dispatcher");
    expect(caller.company?.id).toBe(companyId);
    expect(caller.teamMemberId).toBe(seatId);

    const [row] = await db
      .select({ clerkUserId: teamMembersTable.clerkUserId })
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, seatId));
    expect(row?.clerkUserId).toBe(RETURNING_USER);
  });

  it("stays put when the holder's account still exists", async () => {
    await db
      .update(teamMembersTable)
      .set({ clerkUserId: LIVE_USER })
      .where(eq(teamMembersTable.id, seatId));
    clerkAccounts.set(LIVE_USER, {
      emails: [{ address: SEAT_EMAIL, verified: true }],
    });
    clerkAccounts.set(RETURNING_USER, {
      emails: [{ address: SEAT_EMAIL, verified: true }],
    });

    const caller = await resolveCaller(RETURNING_USER);

    // Sharing an address with a live colleague must never take their seat.
    expect(caller.company).toBeNull();
    const [row] = await db
      .select({ clerkUserId: teamMembersTable.clerkUserId })
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, seatId));
    expect(row?.clerkUserId).toBe(LIVE_USER);
  });

  it("stays put for an unverified email", async () => {
    clerkAccounts.set(RETURNING_USER, {
      emails: [{ address: SEAT_EMAIL, verified: false }],
    });

    const caller = await resolveCaller(RETURNING_USER);

    // Anyone can type an address into a signup form; only verification
    // proves they own it.
    expect(caller.company).toBeNull();
    const [row] = await db
      .select({ clerkUserId: teamMembersTable.clerkUserId })
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, seatId));
    expect(row?.clerkUserId).toBe(GHOST_USER);
  });

  it("stays put while Clerk is unreachable", async () => {
    clerkAccounts.set(RETURNING_USER, {
      emails: [{ address: SEAT_EMAIL, verified: true }],
    });
    clerkUnreachable = true;

    const caller = await resolveCaller(RETURNING_USER);

    // An outage must not be read as "that account is gone" — that would hand
    // seats away every time Clerk hiccups.
    expect(caller.company).toBeNull();
    const [row] = await db
      .select({ clerkUserId: teamMembersTable.clerkUserId })
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, seatId));
    expect(row?.clerkUserId).toBe(GHOST_USER);
  });

  it("leaves a seat alone when the email belongs to nobody here", async () => {
    clerkAccounts.set(RETURNING_USER, {
      emails: [{ address: `stranger_${runId}@test.invalid`, verified: true }],
    });

    const caller = await resolveCaller(RETURNING_USER);

    expect(caller.company).toBeNull();
    const rows = await db
      .select({ clerkUserId: teamMembersTable.clerkUserId })
      .from(teamMembersTable)
      .where(inArray(teamMembersTable.id, [seatId]));
    expect(rows[0]?.clerkUserId).toBe(GHOST_USER);
  });

  it("stays put once the recovery window has closed", async () => {
    // The takeover case. Someone deletes their account and the address is
    // later re-registered by a different person, who verifies it honestly.
    // Every other check passes — the holder really is gone, the email really
    // is verified — and only the closed window stops them walking in.
    await db
      .update(teamMembersTable)
      .set({ recoveryUntil: new Date(Date.now() - 60_000) })
      .where(eq(teamMembersTable.id, seatId));
    clerkAccounts.set(RETURNING_USER, {
      emails: [{ address: SEAT_EMAIL, verified: true }],
    });

    const caller = await resolveCaller(RETURNING_USER);

    expect(caller.company).toBeNull();
    const [row] = await db
      .select({ clerkUserId: teamMembersTable.clerkUserId })
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, seatId));
    expect(row?.clerkUserId).toBe(GHOST_USER);
  });

  it("stays put for a seat that never had a recovery window", async () => {
    // Seats created after the repair — the normal case from here on.
    await db
      .update(teamMembersTable)
      .set({ recoveryUntil: null })
      .where(eq(teamMembersTable.id, seatId));
    clerkAccounts.set(RETURNING_USER, {
      emails: [{ address: SEAT_EMAIL, verified: true }],
    });

    const caller = await resolveCaller(RETURNING_USER);

    expect(caller.company).toBeNull();
  });

  it("matches a stored address that has stray whitespace", async () => {
    await db
      .update(teamMembersTable)
      .set({ email: `  ${SEAT_EMAIL.toUpperCase()} ` })
      .where(eq(teamMembersTable.id, seatId));
    clerkAccounts.set(RETURNING_USER, {
      emails: [{ address: SEAT_EMAIL, verified: true }],
    });

    const caller = await resolveCaller(RETURNING_USER);

    expect(caller.teamMemberId).toBe(seatId);
  });

  it("retries immediately after a Clerk check it could not complete", async () => {
    clerkAccounts.set(RETURNING_USER, {
      emails: [{ address: SEAT_EMAIL, verified: true }],
    });
    // The caller's own lookup succeeds; only the check on the seat's holder
    // fails. Nothing is known about the holder, so nothing may be concluded.
    clerkErroringIds.add(GHOST_USER);

    expect((await resolveCaller(RETURNING_USER)).company).toBeNull();

    // Clerk recovers. Without the indeterminate carve-out the previous answer
    // would be cached and this person would stay locked out for the window.
    clerkErroringIds.clear();
    const caller = await resolveCaller(RETURNING_USER);

    expect(caller.teamMemberId).toBe(seatId);
  });
});

describe("a company whose owner login no longer exists", () => {
  it("re-attaches to the owner's verified email", async () => {
    clerkAccounts.set(RETURNING_OWNER, {
      emails: [{ address: OWNER_EMAIL, verified: true }],
    });

    const caller = await resolveCaller(RETURNING_OWNER);

    // Their company — with every booking, call and setting still in it —
    // rather than an invitation to build an empty second one.
    expect(caller.role).toBe("owner");
    expect(caller.company?.id).toBe(companyId);

    const [row] = await db
      .select({ ownerUserId: companiesTable.ownerUserId })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    expect(row?.ownerUserId).toBe(RETURNING_OWNER);
  });

  it("wins over an invite to somebody else's team", async () => {
    // The same address owns this company AND holds an abandoned seat on it.
    // Owning has to win, or they'd come back as their own dispatcher.
    await db
      .update(teamMembersTable)
      .set({ email: OWNER_EMAIL })
      .where(eq(teamMembersTable.id, seatId));
    clerkAccounts.set(RETURNING_OWNER, {
      emails: [{ address: OWNER_EMAIL, verified: true }],
    });

    const caller = await resolveCaller(RETURNING_OWNER);

    expect(caller.role).toBe("owner");
    expect(caller.teamMemberId).toBeNull();

    await db
      .update(teamMembersTable)
      .set({ email: SEAT_EMAIL })
      .where(eq(teamMembersTable.id, seatId));
  });

  it("stays put when the owner's account still exists", async () => {
    await db
      .update(companiesTable)
      .set({ ownerUserId: LIVE_USER })
      .where(eq(companiesTable.id, companyId));
    clerkAccounts.set(LIVE_USER, {
      emails: [{ address: OWNER_EMAIL, verified: true }],
    });
    clerkAccounts.set(RETURNING_OWNER, {
      emails: [{ address: OWNER_EMAIL, verified: true }],
    });

    const caller = await resolveCaller(RETURNING_OWNER);

    // A shared address must never take a working company off its owner.
    expect(caller.company).toBeNull();
    const [row] = await db
      .select({ ownerUserId: companiesTable.ownerUserId })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    expect(row?.ownerUserId).toBe(LIVE_USER);
  });

  it("stays put for an unverified email", async () => {
    clerkAccounts.set(RETURNING_OWNER, {
      emails: [{ address: OWNER_EMAIL, verified: false }],
    });

    const caller = await resolveCaller(RETURNING_OWNER);

    expect(caller.company).toBeNull();
    const [row] = await db
      .select({ ownerUserId: companiesTable.ownerUserId })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    expect(row?.ownerUserId).toBe(GHOST_OWNER);
  });

  it("stays put while Clerk is unreachable", async () => {
    clerkAccounts.set(RETURNING_OWNER, {
      emails: [{ address: OWNER_EMAIL, verified: true }],
    });
    clerkUnreachable = true;

    const caller = await resolveCaller(RETURNING_OWNER);

    expect(caller.company).toBeNull();
    const [row] = await db
      .select({ ownerUserId: companiesTable.ownerUserId })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    expect(row?.ownerUserId).toBe(GHOST_OWNER);
  });

  it("ignores a company that never recorded an owner email", async () => {
    await db
      .update(companiesTable)
      .set({ ownerEmail: null })
      .where(eq(companiesTable.id, companyId));
    clerkAccounts.set(RETURNING_OWNER, {
      emails: [{ address: OWNER_EMAIL, verified: true }],
    });

    const caller = await resolveCaller(RETURNING_OWNER);

    expect(caller.company).toBeNull();
    const [row] = await db
      .select({ ownerUserId: companiesTable.ownerUserId })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    expect(row?.ownerUserId).toBe(GHOST_OWNER);
  });
});
