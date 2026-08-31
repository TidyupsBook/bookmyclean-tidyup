/**
 * One-time Jobber calendar history catch-up.
 *
 * The rolling calendar sync keeps a nine-month window fresh (90 days back,
 * 180 ahead) — plenty while the window's back edge still reaches the pinned
 * history floor (Aug 1, 2026). But a company that connects Jobber after the
 * window has rolled past the floor would silently miss the gap between the
 * floor and the back edge: old jobs, and the cleaners who worked them, would
 * never appear on the schedule or the map.
 *
 * This service fills that gap exactly once per company, in resumable slices:
 *
 *   floor ──[slice]──[slice]──[slice]──▶ window back edge
 *
 * Contract:
 *  - IMPORT-ONLY. The cancellation sweep is disabled for every slice
 *    (`sweep: false`): a visit absent from an old slice was simply never
 *    imported — treating absence as cancellation over history would cancel
 *    real work. Only the rolling window may sweep.
 *  - One slice per invocation, so a catch-up shares the Jobber rate budget
 *    politely with the rolling poller (the budget is shared across
 *    environments — see the page-size comments in jobberCalendarSync).
 *  - The resume cursor (`jobberHistorySyncedTo`, a YYYY-MM-DD day) advances
 *    only on a COMPLETE slice pull. An incomplete pull logs loudly and
 *    retries the same slice next cycle — explicitly stuck beats silent
 *    data loss.
 *  - `jobberHistoryBackfilledAt` marks the catch-up done forever, so it may
 *    only be stamped off a cycle whose ROLLING pull was itself complete and
 *    fully persisted (`rollingPullComplete`): the stamp certifies the whole
 *    floor→now range, and the window part of that range is the rolling
 *    pull's evidence. Companies whose window still covers the floor are
 *    marked done without pulling — but only under the same certification.
 *  - Slices reuse syncCompanyCalendar, so imported visits flow through the
 *    exact same pipeline as the rolling window — including Jobber-assignee
 *    resolution onto the roster, which is how historical jobs arrive with
 *    their cleaners already attached.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db, companiesTable, type Company } from "@workspace/db";
import { logger } from "../lib/logger";
import { companyDayBounds } from "../lib/dayBounds";
import { JOBBER_HISTORY_FLOOR_DATE } from "../lib/jobberHistory";
import {
  syncCompanyCalendar,
  shiftDate,
  WINDOW_BACK_DAYS,
} from "./jobberCalendarSync";

/**
 * Days per slice. A month keeps a slice's visit count (and therefore its
 * page count) far below the pull's page ceiling for any realistic account,
 * so slices complete and the cursor actually advances.
 */
export const CATCHUP_SLICE_DAYS = 30;

export type HistoryCatchupResult = {
  /** A slice was actually pulled from Jobber on this invocation. */
  ranSlice: boolean;
  /** The catch-up is finished (now or previously) — nothing left to fill. */
  done: boolean;
  imported: number;
  updated: number;
};

const NOOP: HistoryCatchupResult = {
  ranSlice: false,
  done: false,
  imported: 0,
  updated: 0,
};

/** Stamp the done marker, first writer wins; the cursor stays for forensics. */
async function markDone(companyId: number): Promise<void> {
  await db
    .update(companiesTable)
    .set({ jobberHistoryBackfilledAt: new Date() })
    .where(
      and(
        eq(companiesTable.id, companyId),
        isNull(companiesTable.jobberHistoryBackfilledAt),
      ),
    );
}

export type HistoryCatchupOptions = {
  /**
   * Did the caller's rolling calendar pull, in this same cycle, come back
   * complete AND fully persisted? The done marker is forever, and it vouches
   * for the rolling window's part of history too — so it must never be
   * stamped off a cycle whose window pull was skipped (in-flight guard),
   * truncated, or partly unwritten. Slices still run and the cursor still
   * advances regardless; only the final stamp waits for a certified cycle.
   */
  rollingPullComplete: boolean;
};

/**
 * Advance the catch-up by at most one slice. Safe to call every poller
 * cycle and on every manual "Sync now" — it no-ops once done.
 */
export async function runJobberHistoryCatchup(
  company: Company,
  options: HistoryCatchupOptions,
): Promise<HistoryCatchupResult> {
  if (!company.jobberConnected || company.jobberNeedsReauth) return NOOP;

  // Re-read the markers rather than trusting the passed-in row: the caller's
  // company object may predate a previous cycle's advance.
  const [row] = await db
    .select({
      syncedTo: companiesTable.jobberHistorySyncedTo,
      doneAt: companiesTable.jobberHistoryBackfilledAt,
    })
    .from(companiesTable)
    .where(eq(companiesTable.id, company.id));
  if (!row) return NOOP;
  if (row.doneAt) return { ...NOOP, done: true };

  // The gap to fill: floor → the rolling window's back edge, in the
  // company's own zone (same day arithmetic the rolling sync uses).
  const today = companyDayBounds(undefined, company.timezone).date;
  const backEdge = shiftDate(today, -WINDOW_BACK_DAYS);

  // No gap: the rolling window still reaches the floor, so its own pulls
  // cover all wanted history. Mark done without spending any Jobber budget
  // — but only when THIS cycle's rolling pull actually proved the window.
  // (YYYY-MM-DD compares correctly as a string.)
  if (backEdge <= JOBBER_HISTORY_FLOOR_DATE) {
    if (!options.rollingPullComplete) return NOOP;
    await markDone(company.id);
    return { ...NOOP, done: true };
  }

  const from =
    row.syncedTo && row.syncedTo > JOBBER_HISTORY_FLOOR_DATE
      ? row.syncedTo
      : JOBBER_HISTORY_FLOOR_DATE;
  if (from >= backEdge) {
    // A previous slice already reached the (then-current) back edge. Same
    // certification rule as above before the forever-stamp goes on.
    if (!options.rollingPullComplete) return NOOP;
    await markDone(company.id);
    return { ...NOOP, done: true };
  }

  // One slice: [from, to], where `to` overlaps the next slice's `from` by a
  // day on purpose — the upsert dedupes, and a boundary day can never fall
  // through the crack between two slices.
  const sliceEnd = shiftDate(from, CATCHUP_SLICE_DAYS);
  const to = sliceEnd < backEdge ? sliceEnd : backEdge;

  const result = await syncCompanyCalendar(company, null, {
    startDate: from,
    endDate: to,
    sweep: false, // import-only, always — see the module contract above
  });

  if (!result.pullComplete || result.persistFailures > 0) {
    // Loud and stuck beats silently advancing past unpulled — or pulled but
    // unWRITTEN — history. These dates never come back into the rolling
    // window, so a partial slice must retry, not be skipped past. If this
    // persists, the slice size or page ceiling needs a human decision.
    logger.warn(
      {
        companyId: company.id,
        from,
        to,
        hitPageLimit: result.hitPageLimit,
        pullComplete: result.pullComplete,
        persistFailures: result.persistFailures,
      },
      "Jobber history catch-up: slice incomplete — cursor NOT advanced, will retry",
    );
    return { ...NOOP, ranSlice: true };
  }

  // The final stamp additionally needs this cycle's rolling pull certified
  // (see HistoryCatchupOptions); otherwise the cursor still advances and the
  // stamp happens on a later, certified cycle via the from >= backEdge path.
  const finished = to >= backEdge && options.rollingPullComplete;
  await db
    .update(companiesTable)
    .set({
      jobberHistorySyncedTo: to,
      ...(finished ? { jobberHistoryBackfilledAt: new Date() } : {}),
    })
    .where(eq(companiesTable.id, company.id));

  logger.info(
    {
      companyId: company.id,
      from,
      to,
      imported: result.imported,
      updated: result.updated,
      finished,
    },
    "Jobber history catch-up: slice imported",
  );

  return {
    ranSlice: true,
    done: finished,
    imported: result.imported,
    updated: result.updated,
  };
}
