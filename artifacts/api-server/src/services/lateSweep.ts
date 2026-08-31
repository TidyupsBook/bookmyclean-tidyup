/**
 * Background lateness sweep.
 *
 * The live map's toast only fires for whoever has the map open; this sweep
 * evaluates the same route legs server-side every minute and drops a
 * `cleaner_running_late` entry into the company's activity feed the moment a
 * trail first slips past booked time + grace — so a dispatcher working in
 * Bookings or the inbox still hears about it.
 *
 * Directions cost: the sweep reads through the same per-seat cache as
 * GET /map/routes (fresh for 3 minutes), so map-open and map-closed sessions
 * share lookups instead of doubling them.
 */
import { and, eq, gt, gte, inArray } from "drizzle-orm";
import {
  db,
  activityTable,
  bookingsTable,
  companiesTable,
  cleanerLocationsTable,
} from "@workspace/db";
import { LIVE_WITHIN_MS } from "../lib/presence";
import { companyDayBounds } from "../lib/dayBounds";
import { computeRouteLegs, type RouteLeg } from "../lib/routeLegs";
import {
  advanceLateAlerts,
  lateActivityMessage,
  recoveredActivityMessage,
  LATE_ACTIVITY_TYPE,
  RECOVERED_ACTIVITY_TYPE,
} from "../lib/lateness";
import { insertLateEntryOnce } from "../lib/lateActivity";
import { logger } from "../lib/logger";

/**
 * One minute: half the map page's 30s poll would be pointless (the Directions
 * cache is 3 minutes deep), while much slower would let a short slip resolve
 * itself before dispatch ever hears.
 */
export const LATE_SWEEP_INTERVAL_MS = 60_000;

type LegsProvider = (company: {
  id: number;
  timezone: string;
}) => Promise<RouteLeg[]>;

/** Per company: announced bookings → the cleaners late on them. */
const alertedByCompany = new Map<number, Map<number, Set<number>>>();
const seededCompanies = new Set<number>();
/** Per company: the tail of the sweep chain, so sweeps never interleave. */
const companyLocks = new Map<number, Promise<void>>();

/** Test seam: forget everything between test cases. */
export function resetLateSweepState(): void {
  alertedByCompany.clear();
  seededCompanies.clear();
  companyLocks.clear();
}

/**
 * One sweep for one company. `legsProvider` is injectable for tests; prod
 * always reads the real route legs.
 *
 * Sweeps for the same company are serialized: a caller arriving while one is
 * still awaiting legs or DB work queues behind it instead of reading the
 * same not-yet-advanced state and double-announcing a slip.
 */
export function sweepCompanyLateness(
  company: { id: number; timezone: string },
  nowMs: number = Date.now(),
  legsProvider: LegsProvider = computeRouteLegs,
): Promise<void> {
  const prev = companyLocks.get(company.id) ?? Promise.resolve();
  const next = prev.then(() => sweepLocked(company, nowMs, legsProvider));
  // The chain must survive a failed sweep — swallow only for the lock.
  companyLocks.set(
    company.id,
    next.catch(() => {}),
  );
  return next;
}

async function sweepLocked(
  company: { id: number; timezone: string },
  nowMs: number,
  legsProvider: LegsProvider,
): Promise<void> {
  // A restart mid-slip must not re-announce a booking already in today's
  // feed — but a booking whose slip already *ended* (its latest entry is the
  // back-on-time one) must be news again if it slips anew. So the episode is
  // reconstructed from the feed itself: a booking counts as announced only
  // when its most recent lateness entry today is the late one. Member sets
  // start empty, so a seeded booking is forgiven (and its recovery posted)
  // as soon as nothing is late for it.
  if (!seededCompanies.has(company.id)) {
    const { start } = companyDayBounds(undefined, company.timezone);
    const rows = await db
      .select({
        bookingId: activityTable.bookingId,
        type: activityTable.type,
        occurredAt: activityTable.occurredAt,
      })
      .from(activityTable)
      .where(
        and(
          eq(activityTable.companyId, company.id),
          inArray(activityTable.type, [
            LATE_ACTIVITY_TYPE,
            RECOVERED_ACTIVITY_TYPE,
          ]),
          gte(activityTable.occurredAt, start),
        ),
      );
    const latest = new Map<number, { type: string; at: number }>();
    for (const r of rows) {
      if (r.bookingId === null) continue;
      const at = r.occurredAt.getTime();
      const seen = latest.get(r.bookingId);
      if (!seen || at > seen.at) latest.set(r.bookingId, { type: r.type, at });
    }
    const seeded = new Map<number, Set<number>>();
    for (const [bookingId, last] of latest) {
      if (last.type === LATE_ACTIVITY_TYPE) seeded.set(bookingId, new Set());
    }
    alertedByCompany.set(company.id, seeded);
    seededCompanies.add(company.id);
  }

  const legs = await legsProvider(company);
  const prior = alertedByCompany.get(company.id) ?? new Map();
  const state = advanceLateAlerts(prior, legs, company.timezone, nowMs);
  alertedByCompany.set(company.id, state.alerted);

  for (const l of state.fresh) {
    try {
      // Durable backstop against a second writer (another process on the
      // same DB): the insert itself dedupes within a short window. A false
      // return means the row already exists — announced either way.
      const written = await insertLateEntryOnce(
        company.id,
        {
          bookingId: l.bookingId,
          type: LATE_ACTIVITY_TYPE,
          message: lateActivityMessage(l),
        },
        nowMs,
      );
      if (written) {
        logger.info(
          {
            companyId: company.id,
            bookingId: l.bookingId,
            lateMins: l.lateMins,
          },
          "[lateSweep] running-late feed entry raised",
        );
      }
    } catch (err) {
      // The entry never reached the feed, so the booking must not be
      // remembered as announced — un-mark it so the next sweep retries
      // instead of staying silent for the rest of the slip.
      state.alerted.delete(l.bookingId);
      logger.warn(
        { err, companyId: company.id, bookingId: l.bookingId },
        "[lateSweep] feed entry write failed; will retry next sweep",
      );
    }
  }

  for (const bookingId of state.recovered) {
    try {
      const [booking] = await db
        .select({ customerName: bookingsTable.customerName })
        .from(bookingsTable)
        .where(eq(bookingsTable.id, bookingId));
      await insertLateEntryOnce(
        company.id,
        {
          bookingId,
          type: RECOVERED_ACTIVITY_TYPE,
          message: recoveredActivityMessage(booking?.customerName ?? null),
        },
        nowMs,
      );
      logger.info(
        { companyId: company.id, bookingId },
        "[lateSweep] back-on-time feed entry raised",
      );
    } catch (err) {
      // Without this row, a restart would treat the episode as still open
      // and suppress the next slip — keep the booking marked announced so
      // the next sweep detects the recovery again and retries the write.
      state.alerted.set(bookingId, new Set());
      logger.warn(
        { err, companyId: company.id, bookingId },
        "[lateSweep] recovery entry write failed; will retry next sweep",
      );
    }
  }
}

/**
 * Sweep every company that has at least one live phone — no live positions
 * means no trails, means nothing to judge.
 */
let sweepInFlight = false;

export async function runLateSweep(nowMs: number = Date.now()): Promise<void> {
  // A slow cycle (many companies, cold Directions cache) must not stack a
  // second concurrent cycle on top of itself.
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    await runLateSweepCycle(nowMs);
  } finally {
    sweepInFlight = false;
  }
}

async function runLateSweepCycle(nowMs: number): Promise<void> {
  const cutoff = new Date(nowMs - LIVE_WITHIN_MS);
  // Distinct by design: locations are per DEVICE now, so a company whose crew
  // carries a phone and a tablet each would otherwise be swept once per
  // device and announce the same slip several times over.
  const liveRows = await db
    .selectDistinct({ companyId: cleanerLocationsTable.companyId })
    .from(cleanerLocationsTable)
    .where(gt(cleanerLocationsTable.updatedAt, cutoff));
  if (liveRows.length === 0) return;

  for (const { companyId } of liveRows) {
    const [company] = await db
      .select({ id: companiesTable.id, timezone: companiesTable.timezone })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    if (!company) continue;
    try {
      await sweepCompanyLateness(company, nowMs);
    } catch (err) {
      // One company's bad day must not silence the sweep for the rest.
      logger.warn(
        { err, companyId },
        "[lateSweep] sweep failed for company; continuing",
      );
    }
  }
}

let timer: NodeJS.Timeout | null = null;

/** Start the minutely sweep. Idempotent; first pass shortly after boot. */
export function startLateSweep(): void {
  if (timer) return;
  const run = () => {
    runLateSweep().catch((err) =>
      logger.error({ err }, "[lateSweep] sweep run failed"),
    );
  };
  // Let migrations and startup traffic settle first.
  setTimeout(run, 75 * 1000).unref();
  timer = setInterval(run, LATE_SWEEP_INTERVAL_MS);
  timer.unref();
}
