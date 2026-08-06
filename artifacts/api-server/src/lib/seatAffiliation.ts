import { inArray, isNotNull, sql, and } from "drizzle-orm";
import { clerkClient } from "@clerk/express";
import { db, companiesTable, teamMembersTable } from "@workspace/db";
import { logger } from "./logger";

/**
 * One Clerk account can hold exactly one seat (clerk_user_id is unique
 * table-wide) and owning a company always wins during caller resolution. So
 * an invite sent to an address whose person is already attached to a company
 * — as an owner or via a claimed seat anywhere — can NEVER be accepted: it
 * just sits as "Waiting to join" forever.
 *
 * These helpers detect that situation so the invite can be blocked up front
 * and existing stranded invites can be labelled honestly.
 */

/**
 * Of the given addresses, which are already attached to a company and can
 * therefore never claim a new seat?
 *
 * Two signals, both checked:
 *  1. Database — a claimed seat (clerk_user_id set) with the same address.
 *  2. Clerk — an existing account under that address whose user id owns a
 *     company or holds a claimed seat (covers owners, whose email is not in
 *     team_members, and people whose seat email differs from their login).
 *
 * The Clerk check is best-effort: an outage there must not take the Team
 * page down, so failures degrade to "not blocked" rather than throwing.
 */
export async function findBlockedEmails(
  emails: string[],
): Promise<Set<string>> {
  const wanted = Array.from(
    new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean)),
  );
  const blocked = new Set<string>();
  if (wanted.length === 0) return blocked;

  // Signal 1: the address already claimed a seat somewhere.
  const claimedRows = await db
    .select({ email: teamMembersTable.email })
    .from(teamMembersTable)
    .where(
      and(
        isNotNull(teamMembersTable.clerkUserId),
        inArray(sql`lower(${teamMembersTable.email})`, wanted),
      ),
    );
  for (const row of claimedRows) {
    // A claimed seat always has an address, but the column is nullable for
    // staff who never sign in — skip rather than coercing null to "".
    if (row.email) blocked.add(row.email.trim().toLowerCase());
  }

  const remaining = wanted.filter((e) => !blocked.has(e));
  if (remaining.length === 0) return blocked;

  // Signal 2: a Clerk account exists for the address and is already attached
  // to a company (owner or claimed seat under a different seat email).
  try {
    const users = await clerkClient.users.getUserList({
      emailAddress: remaining,
      limit: Math.max(remaining.length, 10),
    });
    const userIds = users.data.map((u) => u.id);
    if (userIds.length === 0) return blocked;

    const [ownedCompanies, claimedSeats] = await Promise.all([
      db
        .select({ ownerUserId: companiesTable.ownerUserId })
        .from(companiesTable)
        .where(inArray(companiesTable.ownerUserId, userIds)),
      db
        .select({ clerkUserId: teamMembersTable.clerkUserId })
        .from(teamMembersTable)
        .where(inArray(teamMembersTable.clerkUserId, userIds)),
    ]);
    const attachedUserIds = new Set<string>([
      ...ownedCompanies.map((c) => c.ownerUserId),
      ...claimedSeats
        .map((s) => s.clerkUserId)
        .filter((id): id is string => id !== null),
    ]);

    for (const user of users.data) {
      if (!attachedUserIds.has(user.id)) continue;
      for (const address of user.emailAddresses) {
        const lower = address.emailAddress.trim().toLowerCase();
        if (remaining.includes(lower)) blocked.add(lower);
      }
    }
  } catch (err) {
    logger.error(
      { err },
      "[seatAffiliation] Clerk lookup failed; treating addresses as unblocked",
    );
  }

  return blocked;
}
