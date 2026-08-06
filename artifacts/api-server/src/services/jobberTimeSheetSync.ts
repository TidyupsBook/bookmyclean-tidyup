/**
 * Pulls time clocked in Jobber's own timer into this app's job clock.
 *
 * The outbound half lives in routes/bookings.ts: a stretch clocked here is
 * written onto the Jobber job as a note, because Jobber's API has no mutation
 * for creating time sheet entries — reading them is all it allows. This is the
 * inbound half, so a crew that clocks in on Jobber's app and a crew that taps
 * Start here both end up in one set of hours the office bills from.
 *
 * Two rules keep the directions from feeding each other:
 *   - An imported stretch carries `jobberTimeEntryId`. That column is never
 *     used for the outbound note, so imported hours are never posted back.
 *   - A running Jobber timer is ignored until it stops. Our own "one open
 *     clock per job" rule belongs to the person standing in the house, and a
 *     ticking entry pulled in from elsewhere would fight it.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
  db,
  bookingsTable,
  bookingTimeEntriesTable,
  type Company,
} from "@workspace/db";
import { getValidAccessToken, jobberGraphql } from "../lib/jobber";
import { logger } from "../lib/logger";

/**
 * How far back to look for clocked time.
 *
 * Short on purpose. Timers are pulled so that hours can be billed, and an
 * invoice is written within days of the visit — paging nine months of history
 * every ten minutes would cost Jobber calls for work nobody is pricing any
 * more. A day forward covers a job that started before midnight in the
 * company's own timezone.
 */
export const TIMESHEET_BACK_DAYS = 21;
export const TIMESHEET_FORWARD_DAYS = 1;

const PAGE_SIZE = 50;
const MAX_PAGES = 20;
/** Stretches fetched per job per request; more are paged in, never dropped. */
const ENTRIES_PER_JOB = 25;
/** Ceiling on the extra pages for one job, so a bad cursor can't loop forever. */
const MAX_ENTRY_PAGES = 20;

const ENTRY_FIELDS = `
  nodes {
    id
    startAt
    endAt
    ticking
    user { name { full } }
  }
  pageInfo { hasNextPage endCursor }
`;

const TIMESHEET_QUERY = `
  query SyncJobTimeSheets($filter: JobFilterAttributes, $first: Int!, $after: String, $entries: Int!) {
    jobs(filter: $filter, first: $first, after: $after) {
      nodes {
        id
        timeSheetEntries(first: $entries) { ${ENTRY_FIELDS} }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const JOB_ENTRIES_QUERY = `
  query SyncOneJobTimeSheets($id: EncodedId!, $first: Int!, $after: String) {
    job(id: $id) {
      id
      timeSheetEntries(first: $first, after: $after) { ${ENTRY_FIELDS} }
    }
  }
`;

export type JobberTimeSheetEntry = {
  id: string;
  startAt: string | null;
  endAt: string | null;
  ticking?: boolean | null;
  user?: { name?: { full?: string | null } | null } | null;
};

export type JobberJobTimeSheets = {
  id: string;
  timeSheetEntries?: {
    nodes?: JobberTimeSheetEntry[] | null;
    pageInfo?: { hasNextPage: boolean; endCursor: string | null } | null;
  } | null;
};

export type ImportableEntry = {
  jobberTimeEntryId: string;
  startedAt: Date;
  endedAt: Date;
  startedByName: string | null;
};

export type TimeSheetSyncResult = { imported: number; updated: number };

/**
 * The stretches from one Jobber job that are safe to record as worked time.
 *
 * Anything still ticking, missing a boundary, or ending before it started is
 * dropped rather than guessed at — an hour invented here turns into a line on
 * a customer's invoice.
 */
export function importableEntries(job: JobberJobTimeSheets): ImportableEntry[] {
  const nodes = job.timeSheetEntries?.nodes ?? [];
  const out: ImportableEntry[] = [];
  for (const node of nodes) {
    if (!node?.id || node.ticking) continue;
    if (!node.startAt || !node.endAt) continue;
    const startedAt = new Date(node.startAt);
    const endedAt = new Date(node.endAt);
    if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
      continue;
    }
    if (endedAt.getTime() <= startedAt.getTime()) continue;
    out.push({
      jobberTimeEntryId: node.id,
      startedAt,
      endedAt,
      startedByName: node.user?.name?.full?.trim() || null,
    });
  }
  return out;
}

/** The window this pull covers, in absolute time. */
export function timeSheetWindow(now: Date): { start: Date; end: Date } {
  const day = 24 * 60 * 60 * 1000;
  return {
    start: new Date(now.getTime() - TIMESHEET_BACK_DAYS * day),
    end: new Date(now.getTime() + TIMESHEET_FORWARD_DAYS * day),
  };
}

/** The stretches past the first page on one job. */
async function fetchRemainingEntries(
  accessToken: string,
  jobId: string,
  after: string | null,
): Promise<JobberTimeSheetEntry[]> {
  const out: JobberTimeSheetEntry[] = [];
  let cursor = after;
  let pages = 0;
  while (cursor && pages < MAX_ENTRY_PAGES) {
    const data: { job?: JobberJobTimeSheets | null } = await jobberGraphql(
      accessToken,
      JOB_ENTRIES_QUERY,
      { id: jobId, first: ENTRIES_PER_JOB, after: cursor },
    );
    const page = data?.job?.timeSheetEntries;
    if (!page?.nodes || !page.pageInfo) break;
    out.push(...page.nodes);
    pages += 1;
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  }
  return out;
}

export async function syncCompanyTimeSheets(
  company: Company,
  now: Date = new Date(),
): Promise<TimeSheetSyncResult> {
  if (!company.jobberConnected || company.jobberNeedsReauth) {
    return { imported: 0, updated: 0 };
  }

  const accessToken = await getValidAccessToken(company);
  const { start, end } = timeSheetWindow(now);

  const jobs: JobberJobTimeSheets[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const data: {
      jobs?: {
        nodes?: JobberJobTimeSheets[];
        pageInfo?: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await jobberGraphql(accessToken, TIMESHEET_QUERY, {
      filter: {
        startAt: { after: start.toISOString(), before: end.toISOString() },
      },
      first: PAGE_SIZE,
      after: cursor,
      entries: ENTRIES_PER_JOB,
    });

    const page = data?.jobs;
    if (!page?.nodes || !page.pageInfo) break;
    jobs.push(...page.nodes);
    pages += 1;
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (cursor && pages >= MAX_PAGES) {
      // Say so rather than returning a short pull as if it were the lot: the
      // hours left behind are hours nobody would know to look for.
      logger.warn(
        { companyId: company.id, pages },
        "Jobber time sheet sync: hit the page ceiling, some jobs not read",
      );
      cursor = null;
    }
  } while (cursor);

  // A job with more stretches than one page holds must not lose the rest —
  // the missing ones are billable hours that would never be looked for.
  for (const job of jobs) {
    const info = job.timeSheetEntries?.pageInfo;
    if (!info?.hasNextPage || !job.timeSheetEntries) continue;
    try {
      const rest = await fetchRemainingEntries(
        accessToken,
        job.id,
        info.endCursor,
      );
      job.timeSheetEntries.nodes = [
        ...(job.timeSheetEntries.nodes ?? []),
        ...rest,
      ];
    } catch (err) {
      logger.warn(
        { err, companyId: company.id, jobberJobId: job.id },
        "Jobber time sheet sync: could not read every stretch on a job",
      );
    }
  }

  const withEntries = jobs.filter(
    (job) => (job.timeSheetEntries?.nodes?.length ?? 0) > 0,
  );
  if (withEntries.length === 0) return { imported: 0, updated: 0 };

  // Only jobs we actually imported have a booking to hang the hours on.
  const bookings = await db
    .select({
      id: bookingsTable.id,
      jobberSyncedJobId: bookingsTable.jobberSyncedJobId,
    })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.companyId, company.id),
        inArray(
          bookingsTable.jobberSyncedJobId,
          withEntries.map((job) => job.id),
        ),
      ),
    );
  const bookingByJob = new Map(
    bookings.map((b) => [b.jobberSyncedJobId!, b.id] as const),
  );

  let imported = 0;
  let updated = 0;

  // What we already hold from Jobber, so a stretch is recorded once and a
  // stretch corrected in Jobber corrects the hours here too.
  const known = await db
    .select({
      id: bookingTimeEntriesTable.id,
      jobberTimeEntryId: bookingTimeEntriesTable.jobberTimeEntryId,
      startedAt: bookingTimeEntriesTable.startedAt,
      endedAt: bookingTimeEntriesTable.endedAt,
      editedAt: bookingTimeEntriesTable.editedAt,
    })
    .from(bookingTimeEntriesTable)
    .where(
      and(
        eq(bookingTimeEntriesTable.companyId, company.id),
        isNotNull(bookingTimeEntriesTable.jobberTimeEntryId),
      ),
    );
  const knownByJobberId = new Map(
    known.map((row) => [row.jobberTimeEntryId!, row] as const),
  );

  for (const job of withEntries) {
    const bookingId = bookingByJob.get(job.id);
    if (!bookingId) continue;

    for (const entry of importableEntries(job)) {
      try {
        const held = knownByJobberId.get(entry.jobberTimeEntryId);
        if (!held) {
          const inserted = await db
            .insert(bookingTimeEntriesTable)
            .values({
              companyId: company.id,
              bookingId,
              teamMemberId: null,
              startedByName: entry.startedByName,
              startedAt: entry.startedAt,
              endedAt: entry.endedAt,
              jobberTimeEntryId: entry.jobberTimeEntryId,
            })
            // Two pulls overlapping is not an error; the second adds nothing.
            .onConflictDoNothing()
            .returning({ id: bookingTimeEntriesTable.id });
          // Count only what this run actually recorded. A manual sync and the
          // poller racing must not report the same stretch as imported twice.
          if (inserted.length > 0) imported += 1;
          continue;
        }

        // Times the office corrected by hand outrank Jobber's copy: someone
        // looked at this job and made a call, and a pull must not undo it.
        if (held.editedAt) continue;

        const unchanged =
          held.startedAt.getTime() === entry.startedAt.getTime() &&
          held.endedAt?.getTime() === entry.endedAt.getTime();
        if (unchanged) continue;

        await db
          .update(bookingTimeEntriesTable)
          .set({
            startedAt: entry.startedAt,
            endedAt: entry.endedAt,
            startedByName: entry.startedByName,
          })
          .where(
            and(
              eq(bookingTimeEntriesTable.id, held.id),
              eq(bookingTimeEntriesTable.companyId, company.id),
            ),
          );
        updated += 1;
      } catch (err) {
        logger.warn(
          { err, companyId: company.id, bookingId },
          "Jobber time sheet sync: could not record a stretch",
        );
      }
    }
  }

  return { imported, updated };
}
