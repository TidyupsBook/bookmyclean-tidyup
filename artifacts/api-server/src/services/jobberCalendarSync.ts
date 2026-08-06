/**
 * Pulls scheduled jobs *out* of Jobber and onto our calendar and map.
 *
 * The outbound sync in routes/bookings.ts pushes a booking we took into Jobber
 * as a work request. This is the other direction: an owner who books most of
 * their work in Jobber still expects those addresses to show up on the live
 * map, and typing them in twice is not a plan.
 *
 * Two rules keep the directions from fighting:
 *   - An imported booking is tagged with `jobberSyncedJobId`. Nothing else is
 *     ever touched by this sync, so a booking taken by the AI receptionist can
 *     never be overwritten or cancelled by a Jobber pull.
 *   - Coordinates are left to the existing geocode backfill. Import writes the
 *     address; the backfill turns it into a pin a few minutes later, exactly
 *     as it does for bookings we take ourselves.
 */
import { and, eq, gte, inArray, isNotNull, lt, ne } from "drizzle-orm";
import { db, companiesTable, bookingsTable, type Company } from "@workspace/db";
import { getValidAccessToken, jobberGraphql } from "../lib/jobber";
import { companyDayBounds } from "../lib/dayBounds";
import { logger } from "../lib/logger";

/** How often the background pull runs. */
export const JOBBER_SYNC_INTERVAL_MS = 10 * 60 * 1000;
/**
 * Rolling window the poller keeps fresh: three months back, six months ahead.
 *
 * It reaches backwards because the map answers "where are my clients", not
 * just "where is the crew today" — a house cleaned monthly is invisible on a
 * 60-day forward window if its last visit was in the spring. Both spans are
 * where the owner drew the line: far enough to catch occasional clients and
 * recurring cleans booked well ahead, short enough that the calendar isn't
 * buried in work nobody is thinking about yet.
 */
const WINDOW_BACK_DAYS = 90;
const WINDOW_FORWARD_DAYS = 180;
/**
 * 100 jobs a page; a hard stop so one runaway account can't page forever.
 * The window spans nine months, so the ceiling has to clear a busy account's
 * real volume — hitting it silently disables the cancellation sweep.
 */
const PAGE_SIZE = 100;
const MAX_PAGES = 60;

export type JobberCalendarJob = {
  id: string;
  title: string | null;
  startAt: string | null;
  endAt: string | null;
  client: {
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
  } | null;
  property: {
    address: {
      street: string | null;
      city: string | null;
      province: string | null;
      postalCode: string | null;
    } | null;
  } | null;
};

export type CalendarSyncResult = {
  imported: number;
  updated: number;
  skipped: number;
  canceled: number;
  jobberCount: number;
  hitPageLimit: boolean;
};

const EMPTY_RESULT: CalendarSyncResult = {
  imported: 0,
  updated: 0,
  skipped: 0,
  canceled: 0,
  jobberCount: 0,
  hitPageLimit: false,
};

const JOBS_QUERY = `
  query SyncCalendarJobs($filter: JobFilterAttributes, $first: Int!, $after: String) {
    jobs(filter: $filter, first: $first, after: $after) {
      nodes {
        id
        title
        startAt
        endAt
        client { firstName lastName phone }
        property { address { street city province postalCode } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** "12 Main St, Calgary, AB T2P 1J9" from Jobber's address parts. */
export function formatJobberAddress(job: JobberCalendarJob): string | null {
  const a = job.property?.address;
  if (!a) return null;
  const line = [a.street, a.city, a.province].filter(Boolean).join(", ");
  const full = [line, a.postalCode].filter(Boolean).join(" ").trim();
  return full.length > 0 ? full : null;
}

/** The name a dispatcher will recognise on the map. */
export function jobberCustomerName(job: JobberCalendarJob): string {
  const person = [job.client?.firstName, job.client?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (person) return person;
  // No client on the job — the title is the only human-readable handle left.
  return job.title?.trim() || "Jobber job";
}

/** Minutes between start and end, when Jobber gave us both. */
export function jobberDurationMinutes(job: JobberCalendarJob): number | null {
  if (!job.startAt || !job.endAt) return null;
  const start = new Date(job.startAt).getTime();
  const end = new Date(job.endAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  return Math.round((end - start) / 60_000);
}

/** Shift a YYYY-MM-DD by whole days, anchored at noon so DST can't bite. */
function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const anchor = new Date(Date.UTC(y, m - 1, d, 12));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
}

/**
 * One company at a time, and never twice at once. The poller and an owner
 * hitting "Sync now" would otherwise race each other into duplicate inserts.
 */
const inFlight = new Set<number>();

export async function syncCompanyCalendar(
  company: Company,
  options: { startDate?: string; endDate?: string } = {},
): Promise<CalendarSyncResult> {
  if (!company.jobberConnected || company.jobberNeedsReauth) {
    return { ...EMPTY_RESULT };
  }
  if (inFlight.has(company.id)) return { ...EMPTY_RESULT };
  inFlight.add(company.id);
  try {
    return await runSync(company, options);
  } finally {
    inFlight.delete(company.id);
  }
}

async function runSync(
  company: Company,
  options: { startDate?: string; endDate?: string },
): Promise<CalendarSyncResult> {
  const today = companyDayBounds(undefined, company.timezone).date;
  const startDate = options.startDate ?? shiftDate(today, -WINDOW_BACK_DAYS);
  const endDate = options.endDate ?? shiftDate(today, WINDOW_FORWARD_DAYS);

  // Window boundaries in the company's zone, so a job at 8am local is inside
  // the day the owner thinks it is.
  const windowStart = companyDayBounds(startDate, company.timezone).start;
  const windowEnd = companyDayBounds(endDate, company.timezone).end;

  const accessToken = await getValidAccessToken(company);

  const jobs: JobberCalendarJob[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let hitPageLimit = false;
  /**
   * Did Jobber hand us its complete inventory for this window?
   *
   * Only a complete pull may drive cancellations. Everything else — a page
   * that came back without a payload, a response missing its pagination
   * block — means "we don't know what Jobber has", and the difference between
   * "not in the pull" and "canceled in Jobber" collapses. Getting that wrong
   * now wipes nine months of a company's calendar, so absence of evidence
   * must never be read as evidence of cancellation.
   */
  let pullComplete = true;

  type JobsPage = {
    nodes: JobberCalendarJob[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };

  do {
    const data: { jobs: JobsPage } = await jobberGraphql<{ jobs: JobsPage }>(
      accessToken,
      JOBS_QUERY,
      {
        // Jobber API 2025-04-16 filters scheduled work by a startAt range;
        // older versions used `scheduledBetween`, which no longer exists.
        filter: {
          startAt: {
            after: windowStart.toISOString(),
            before: windowEnd.toISOString(),
          },
        },
        first: PAGE_SIZE,
        after: cursor,
      },
    );

    const page = data?.jobs;
    if (!page?.nodes || !page.pageInfo) {
      // A shape we don't recognise. Import nothing further and, crucially,
      // don't let the sweep treat this truncated pull as the whole truth.
      pullComplete = false;
      logger.warn(
        { companyId: company.id, pages },
        "Jobber calendar sync: incomplete page, skipping cancellation sweep",
      );
      break;
    }
    jobs.push(...page.nodes);
    pages += 1;
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (cursor && pages >= MAX_PAGES) {
      hitPageLimit = true;
      cursor = null;
    }
  } while (cursor);

  let imported = 0;
  let updated = 0;
  let skipped = 0;

  for (const job of jobs) {
    try {
      const outcome = await upsertJob(company, job);
      if (outcome === "imported") imported += 1;
      else if (outcome === "updated") updated += 1;
      else skipped += 1;
    } catch (err) {
      skipped += 1;
      logger.warn(
        { err, companyId: company.id, jobberJobId: job.id },
        "Jobber calendar sync: could not import a job",
      );
    }
  }

  // Cancel only off a pull we know is the whole window: every page received
  // and understood, and the page ceiling never reached.
  const canceled =
    hitPageLimit || !pullComplete
      ? 0
      : await sweepCanceled(
          company,
          windowStart,
          windowEnd,
          jobs.map((j) => j.id),
        );

  return {
    imported,
    updated,
    skipped,
    canceled,
    jobberCount: jobs.length,
    hitPageLimit,
  };
}

async function upsertJob(
  company: Company,
  job: JobberCalendarJob,
): Promise<"imported" | "updated" | "skipped"> {
  // An unscheduled job has nowhere to sit on a calendar.
  if (!job.startAt) return "skipped";
  const scheduledFor = new Date(job.startAt);
  if (Number.isNaN(scheduledFor.getTime())) return "skipped";

  const address = formatJobberAddress(job);
  const fields = {
    customerName: jobberCustomerName(job),
    customerPhone: job.client?.phone ?? "",
    customerAddress: address,
    service: job.title?.trim() || "Jobber job",
    scheduledFor,
    durationMinutes: jobberDurationMinutes(job),
  };

  const [existing] = await db
    .select({
      id: bookingsTable.id,
      customerAddress: bookingsTable.customerAddress,
      status: bookingsTable.status,
    })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.companyId, company.id),
        eq(bookingsTable.jobberSyncedJobId, job.id),
      ),
    );

  if (!existing) {
    await db.insert(bookingsTable).values({
      companyId: company.id,
      callId: null,
      ...fields,
      // It's on the calendar in Jobber, so it's a real commitment — not a
      // lead waiting to be confirmed.
      status: "confirmed",
      jobberSyncedJobId: job.id,
      jobberSynced: true,
    });
    return "imported";
  }

  // A moved address must lose its old pin, or the map keeps showing the crew
  // the house the customer used to live at until someone notices.
  const addressChanged = (existing.customerAddress ?? null) !== address;
  await db
    .update(bookingsTable)
    .set({
      ...fields,
      // Reappearing in Jobber un-cancels a job the previous sweep cancelled.
      status: existing.status === "completed" ? "completed" : "confirmed",
      ...(addressChanged ? { lat: null, lng: null, geocodedAt: null } : {}),
    })
    .where(eq(bookingsTable.id, existing.id));
  return "updated";
}

/**
 * Jobs we imported that have since vanished from Jobber were cancelled or
 * deleted there. Mark them cancelled rather than deleting: the owner's history
 * (and any deposit taken against them) has to survive.
 *
 * Only ever touches rows this sync created — an untagged booking is ours.
 */
async function sweepCanceled(
  company: Company,
  windowStart: Date,
  windowEnd: Date,
  seenJobIds: string[],
): Promise<number> {
  try {
    const seen = new Set(seenJobIds);
    const rows = await db
      .select({
        id: bookingsTable.id,
        jobberSyncedJobId: bookingsTable.jobberSyncedJobId,
      })
      .from(bookingsTable)
      .where(
        and(
          eq(bookingsTable.companyId, company.id),
          isNotNull(bookingsTable.jobberSyncedJobId),
          gte(bookingsTable.scheduledFor, windowStart),
          lt(bookingsTable.scheduledFor, windowEnd),
          ne(bookingsTable.status, "canceled"),
        ),
      );

    const gone = rows
      .filter((r) => !seen.has(r.jobberSyncedJobId!))
      .map((r) => r.id);
    if (gone.length === 0) return 0;

    await db
      .update(bookingsTable)
      .set({ status: "canceled" })
      .where(inArray(bookingsTable.id, gone));
    logger.info(
      { companyId: company.id, count: gone.length },
      "Jobber calendar sync: cancelled bookings that left Jobber",
    );
    return gone.length;
  } catch (err) {
    // A failed sweep must not throw away a successful import.
    logger.warn(
      { err, companyId: company.id },
      "Jobber calendar sync: cancellation sweep failed",
    );
    return 0;
  }
}

/* ───────────────────────── background poller ───────────────────────── */

export async function runJobberCalendarSyncCycle(): Promise<void> {
  const companies = await db
    .select()
    .from(companiesTable)
    .where(
      and(
        eq(companiesTable.jobberConnected, true),
        eq(companiesTable.jobberNeedsReauth, false),
      ),
    );

  for (const company of companies) {
    try {
      const result = await syncCompanyCalendar(company);
      if (result.imported || result.updated || result.canceled) {
        logger.info(
          { companyId: company.id, ...result },
          "Jobber calendar sync complete",
        );
      }
    } catch (err) {
      // One company's dead token must not stop the others syncing.
      logger.warn(
        { err, companyId: company.id },
        "Jobber calendar sync failed for company",
      );
    }
  }
}

let timer: NodeJS.Timeout | null = null;

/** First pass a couple of minutes after boot, then every ten minutes. */
export function startJobberCalendarSync(): void {
  if (timer) return;
  const run = () => {
    runJobberCalendarSyncCycle().catch((err) =>
      logger.error({ err }, "Jobber calendar sync cycle failed"),
    );
  };
  setTimeout(run, 120 * 1000).unref();
  timer = setInterval(run, JOBBER_SYNC_INTERVAL_MS);
  timer.unref();
}
