import { and, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { clerkClient } from "@clerk/express";
import {
  db,
  companiesTable,
  teamMembersTable,
  activityTable,
  type Company,
} from "@workspace/db";
import { logger } from "./logger";

/**
 * Who is calling, and what they are allowed to touch.
 *
 * OWNER      — the Clerk account on `companies.owner_user_id`, or a signed-in
 *              account that has no company yet and is about to create one.
 *              Full access, including company configuration and billing.
 * DISPATCHER — holds a `team_members` seat with role `dispatcher`. Runs the
 *              day-to-day board: calls, bookings, quotes, crews. Cannot touch
 *              company configuration, Quo/Jobber connections or the team.
 * CLEANER    — holds a `team_members` seat with role `cleaner`. Sees only the
 *              jobs they are assigned to, and may only move those between
 *              statuses.
 *
 * This is the authorization boundary for the whole API. Resolving a company
 * is NOT the same as being allowed to act on it — routes must state which
 * roles they accept via `requireRole`.
 */
export type CallerRole = "owner" | "dispatcher" | "cleaner";

export type Caller = {
  role: CallerRole;
  /**
   * Null only for a signed-in account with no company and no seat — a
   * prospective owner part-way through onboarding.
   */
  company: Company | null;
  /** Null for the owner, whose access comes from owning the company. */
  teamMemberId: number | null;
  /** Seat display fields. Empty for an owner; `/me` enriches those override. */
  name: string;
  email: string;
};

/**
 * Signed-in accounts that matched nothing are cached briefly so a visitor
 * refreshing the page does not hit Clerk on every request, while an invite
 * created seconds ago still takes effect within the minute.
 */
const BOOTSTRAP_RECHECK_MS = 60_000;
const bootstrapNegativeCache = new Map<string, number>();

/**
 * The address to stamp on a company at creation, so ownership survives the
 * login that created it. Verified only, and null rather than a guess when
 * Clerk can't say — a wrong address here would be an ownership handle pointing
 * at the wrong person.
 */
export async function ownerEmailFor(userId: string): Promise<string | null> {
  try {
    const [first] = await verifiedEmailsFor(userId);
    return first ?? null;
  } catch (err) {
    logger.error({ err, userId }, "[callerRole] owner email lookup failed");
    return null;
  }
}

/** Verified addresses only — verification is what proves the caller owns it. */
async function verifiedEmailsFor(userId: string): Promise<string[]> {
  const user = await clerkClient.users.getUser(userId);
  return user.emailAddresses
    .filter((e) => e.verification?.status === "verified")
    .map((e) => e.emailAddress.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Is this Clerk account definitively gone?
 *
 * Only a 404 counts as "gone". An outage, a timeout or a rate limit is
 * "unknown" rather than either answer — this decides whether to release
 * somebody's seat, and a false positive hands it to the wrong person. "unknown"
 * is kept distinct from "alive" so the caller can tell a settled no from a
 * question it could not ask, and avoid caching the latter as a refusal.
 */
type AccountState = "gone" | "alive" | "unknown";

async function clerkUserState(userId: string): Promise<AccountState> {
  try {
    await clerkClient.users.getUser(userId);
    return "alive";
  } catch (err) {
    if ((err as { status?: number })?.status === 404) return "gone";
    logger.error({ err, userId }, "[callerRole] stale account check failed");
    return "unknown";
  }
}

/**
 * A recovery attempt and whether anything about it went unanswered. An
 * indeterminate attempt must not be cached as "this person has nothing here" —
 * they may well have, and we simply could not reach Clerk to confirm it.
 */
type Recovery<T> = { value: T | null; indeterminate: boolean };

/**
 * A seat can end up held by a Clerk account that no longer exists: the account
 * was deleted, or the database was copied between Clerk instances so its ids
 * were never valid here. The seat still reads as "claimed", so the invite
 * match below skips it, and the real person is dropped into onboarding on
 * every single sign-in — where the only thing on offer is creating a second,
 * empty company beside the one they already belong to.
 *
 * Releasing the seat needs three independent facts: the seat is inside its
 * recovery window, the caller's email is VERIFIED and matches it, and the
 * account holding it is confirmed gone.
 */
async function reclaimAbandonedSeat(
  userId: string,
  emails: string[],
): Promise<Recovery<number>> {
  let indeterminate = false;

  // Bounded: each candidate costs a Clerk round trip, and one person holding
  // more than a handful of same-email seats is not a real scenario.
  const held = await db
    .select({
      id: teamMembersTable.id,
      clerkUserId: teamMembersTable.clerkUserId,
    })
    .from(teamMembersTable)
    .where(
      and(
        isNotNull(teamMembersTable.clerkUserId),
        ne(teamMembersTable.clerkUserId, userId),
        // Stored addresses predate the trimming done on the Clerk side, so
        // normalize both ends or a stray space silently blocks recovery.
        inArray(sql`lower(trim(${teamMembersTable.email}))`, emails),
        gt(teamMembersTable.recoveryUntil, new Date()),
      ),
    )
    .orderBy(teamMembersTable.id)
    .limit(5);

  for (const seat of held) {
    const staleUserId = seat.clerkUserId!;
    const state = await clerkUserState(staleUserId);
    if (state === "unknown") indeterminate = true;
    if (state !== "gone") continue;

    // Pinning the old id in the WHERE keeps this safe against a concurrent
    // claim: whoever gets there first wins and the other pass simply misses.
    const [taken] = await db
      .update(teamMembersTable)
      .set({ clerkUserId: userId, status: "active", claimedAt: new Date() })
      .where(
        and(
          eq(teamMembersTable.id, seat.id),
          eq(teamMembersTable.clerkUserId, staleUserId),
        ),
      )
      .returning({ id: teamMembersTable.id });

    if (taken) {
      logger.warn(
        { userId, seatId: seat.id, staleUserId },
        "[callerRole] seat released from a deleted account and re-claimed",
      );
      return { value: taken.id, indeterminate };
    }
  }

  return { value: null, indeterminate };
}

/**
 * The same rescue as `reclaimAbandonedSeat`, for the person who owns the
 * place. An owner has no seat to fall back on: when `owner_user_id` points at
 * an account that no longer exists, the company still holds every booking,
 * call and setting, but nobody on earth can reach it — the owner signs in, is
 * told they have no workspace, and is invited to build a second empty one
 * beside it. Forever, on every attempt.
 *
 * `owner_email` is the handle that survives the login, but only inside the
 * recovery window — see the column comment for why an open-ended version of
 * this would be a way to take over a company by acquiring an old address.
 * Re-attaching demands all three: the window is open, the caller's email is
 * VERIFIED and matches, and the stored account is confirmed gone.
 */
async function reclaimAbandonedCompany(
  userId: string,
  emails: string[],
): Promise<Recovery<Company>> {
  let indeterminate = false;

  const orphans = await db
    .select({
      id: companiesTable.id,
      ownerUserId: companiesTable.ownerUserId,
    })
    .from(companiesTable)
    .where(
      and(
        isNotNull(companiesTable.ownerEmail),
        ne(companiesTable.ownerUserId, userId),
        inArray(sql`lower(trim(${companiesTable.ownerEmail}))`, emails),
        gt(companiesTable.ownerRecoveryUntil, new Date()),
      ),
    )
    .orderBy(companiesTable.id)
    .limit(5);

  for (const orphan of orphans) {
    const state = await clerkUserState(orphan.ownerUserId);
    if (state === "unknown") indeterminate = true;
    if (state !== "gone") continue;

    const [taken] = await db
      .update(companiesTable)
      .set({ ownerUserId: userId })
      .where(
        and(
          eq(companiesTable.id, orphan.id),
          eq(companiesTable.ownerUserId, orphan.ownerUserId),
        ),
      )
      .returning();

    if (taken) {
      logger.warn(
        { userId, companyId: orphan.id, staleUserId: orphan.ownerUserId },
        "[callerRole] company re-attached to its owner after a dead login",
      );
      return { value: taken, indeterminate };
    }
  }

  return { value: null, indeterminate };
}

/**
 * First sign-in for an invited person: match a VERIFIED Clerk email to a seat
 * that nobody has claimed yet and attach the account to it.
 *
 * This is the only path that calls Clerk, and it is skipped entirely for
 * anyone who already owns a company or holds a seat — so the common request
 * never leaves the database.
 */
async function tryClaimSeat(userId: string): Promise<Caller | null> {
  const dueAt = bootstrapNegativeCache.get(userId);
  if (dueAt !== undefined && Date.now() < dueAt) return null;

  let emails: string[];
  try {
    emails = await verifiedEmailsFor(userId);
  } catch (err) {
    // Not cached: a Clerk outage must not lock a legitimate invitee out for
    // the full window once Clerk recovers.
    logger.error({ err, userId }, "[callerRole] Clerk user lookup failed");
    return null;
  }

  // Set when a recovery check could not be completed — Clerk timed out, rate
  // limited, or errored. The caller may genuinely have a company or a seat
  // waiting, so the "nothing here" answer below must not be cached.
  let indeterminate = false;

  if (emails.length > 0) {
    // Ownership is checked before invites, matching the order in
    // `resolveCaller`: someone who owns a company is its owner even if that
    // same address was also invited onto another team.
    const reattached = await reclaimAbandonedCompany(userId, emails);
    indeterminate ||= reattached.indeterminate;
    if (reattached.value) {
      bootstrapNegativeCache.delete(userId);
      return {
        role: "owner",
        company: reattached.value,
        teamMemberId: null,
        name: "",
        email: "",
      };
    }

    // Oldest matching invite wins, so the outcome is deterministic when two
    // companies happen to have invited the same address.
    const [pending] = await db
      .select({ id: teamMembersTable.id })
      .from(teamMembersTable)
      .where(
        and(
          isNull(teamMembersTable.clerkUserId),
          inArray(sql`lower(trim(${teamMembersTable.email}))`, emails),
        ),
      )
      .orderBy(teamMembersTable.id)
      .limit(1);

    // Re-checking `clerk_user_id IS NULL` in the UPDATE is what makes this
    // safe: two concurrent first requests cannot both take the seat, and a
    // seat claimed or deleted while Clerk was being queried is simply missed
    // rather than resurrected.
    const claimedId = pending
      ? ((
          await db
            .update(teamMembersTable)
            .set({
              clerkUserId: userId,
              status: "active",
              claimedAt: new Date(),
            })
            .where(
              and(
                eq(teamMembersTable.id, pending.id),
                isNull(teamMembersTable.clerkUserId),
              ),
            )
            .returning({ id: teamMembersTable.id })
        )[0]?.id ?? null)
      : // No free seat under this address. Before giving up, check whether one
        // is only nominally taken — held by an account that no longer exists.
        await (async () => {
          const recovered = await reclaimAbandonedSeat(userId, emails);
          indeterminate ||= recovered.indeterminate;
          return recovered.value;
        })();

    const [claimed] = claimedId
      ? await db
          .select()
          .from(teamMembersTable)
          .where(eq(teamMembersTable.id, claimedId))
      : [];

    if (claimed) {
      const [company] = await db
        .select()
        .from(companiesTable)
        .where(eq(companiesTable.id, claimed.companyId));

      if (company) {
        bootstrapNegativeCache.delete(userId);
        await db.insert(activityTable).values({
          companyId: company.id,
          type: "team_invited",
          message: `${claimed.name} accepted their invite and can now sign in as a ${claimed.role}.`,
        });
        return {
          role: claimed.role as CallerRole,
          company,
          teamMemberId: claimed.id,
          name: claimed.name,
          // A seat can exist without an address (staff who never sign in), but
          // a caller who just claimed one by verified email always has it.
          email: claimed.email ?? "",
        };
      }
    }
  }

  // "Nothing here" is only worth remembering when we actually got to look. If
  // a recovery check went unanswered, re-check on the next request instead of
  // holding someone out of their own company for the full window.
  if (!indeterminate) {
    bootstrapNegativeCache.set(userId, Date.now() + BOOTSTRAP_RECHECK_MS);
  }
  return null;
}

export async function resolveCaller(userId: string): Promise<Caller> {
  // Owning a company always wins, so an owner who was also invited as a
  // cleaner keeps full access rather than being locked into the crew view.
  const [owned] = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.ownerUserId, userId));
  if (owned) {
    return {
      role: "owner",
      company: owned,
      teamMemberId: null,
      name: "",
      email: "",
    };
  }

  const [seat] = await db
    .select()
    .from(teamMembersTable)
    .where(eq(teamMembersTable.clerkUserId, userId))
    .limit(1);

  if (seat) {
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.id, seat.companyId));
    if (company) {
      return {
        role: seat.role as CallerRole,
        company,
        teamMemberId: seat.id,
        name: seat.name,
        email: seat.email ?? "",
      };
    }
  }

  const claimed = await tryClaimSeat(userId);
  if (claimed) return claimed;

  // Nothing to attach to: treat as a prospective owner so onboarding can
  // create a company. They can reach nothing else, because every other route
  // requires a resolved company.
  return {
    role: "owner",
    company: null,
    teamMemberId: null,
    name: "",
    email: "",
  };
}

/** Clear the negative cache so a fresh invite is honoured immediately. */
export function forgetDeniedCaller(): void {
  bootstrapNegativeCache.clear();
}
