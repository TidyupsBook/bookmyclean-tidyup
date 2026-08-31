/**
 * Durable, deduplicated insertion of lateness feed entries (running-late and
 * back-on-time).
 *
 * The sweep's once-per-slip memory is in-process; this is the backstop for
 * whatever that memory can't see — an overlapping sweep, or a second server
 * process pointed at the same database. The write takes a transaction-scoped
 * advisory lock keyed on (company, booking, type) and re-checks inside the
 * lock, so two writers racing on the same event produce one feed row.
 */
import { and, eq, gt, sql } from "drizzle-orm";
import { db, activityTable } from "@workspace/db";

/**
 * 90 seconds — 1.5 sweep intervals. Overlapping writers land within one
 * interval of each other, while a genuine repeat event (which needs at least
 * an opposite-direction sweep in between) comfortably outlives the window.
 */
export const LATE_ENTRY_DEDUPE_MS = 90_000;

export type LateFeedEntry = {
  bookingId: number;
  type: string;
  message: string;
};

/**
 * Insert the feed entry unless an equivalent one landed inside the dedupe
 * window. Returns whether a row was written.
 */
export async function insertLateEntryOnce(
  companyId: number,
  entry: LateFeedEntry,
  nowMs: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Serialize writers across database clients, not just this process: a
    // transaction-scoped advisory lock keyed on the event means the second
    // writer waits until the first commits, then sees its row in the check
    // below. Released automatically at commit/rollback.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`late:${companyId}:${entry.bookingId}:${entry.type}`}))`,
    );
    const dupes = await tx
      .select({ id: activityTable.id })
      .from(activityTable)
      .where(
        and(
          eq(activityTable.companyId, companyId),
          eq(activityTable.type, entry.type),
          eq(activityTable.bookingId, entry.bookingId),
          gt(activityTable.occurredAt, new Date(nowMs - LATE_ENTRY_DEDUPE_MS)),
        ),
      );
    if (dupes.length > 0) return false;
    await tx.insert(activityTable).values({
      companyId,
      type: entry.type,
      message: entry.message,
      bookingId: entry.bookingId,
    });
    return true;
  });
}
