import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  isNotNull,
  lt,
} from "drizzle-orm";
import { db, bookingsTable, geocodedAddressesTable } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  geocodeAddress,
  normalizeAddress,
  GeocodeConfigError,
} from "./geocode";

/**
 * Background geocoding of bookings so the live map loads pins straight from
 * the DB rather than hitting Google on every dashboard open.
 *
 * The work is grouped by address, not by booking. Cleaning is repeat business:
 * a season of imported Jobber jobs is hundreds of bookings across a few dozen
 * houses, and the same house cleaned weekly is one address, not fifty. So each
 * cycle collects the un-pinned bookings, folds them down to distinct
 * addresses, answers as many as it can from the stored cache for free, and
 * spends its Google budget only on addresses nobody has ever resolved. One
 * lookup then fills every booking at that address at once.
 *
 * When the key is missing or Google answers REQUEST_DENIED, the whole thing
 * degrades quietly: it logs once, stops for the cycle, and does not crash the
 * server or spam the logs every ten minutes.
 */

/** Ten minutes: often enough that a new booking is on the map soon, gentle on quota. */
export const GEOCODE_BACKFILL_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Distinct addresses we'll pay Google for in one cycle.
 *
 * Sized against a first import rather than steady state: bringing in a season
 * of history should finish in a cycle or two, not trickle onto the map over an
 * afternoon. Cost is bounded by how many distinct houses a company cleans,
 * which is a one-time charge — repeat visits are cache hits forever after.
 */
const LOOKUPS_PER_CYCLE = 200;

/**
 * How many un-pinned bookings to fold into addresses per cycle. Generous,
 * because everything past the Google budget is either a free cache hit or
 * simply waits for the next cycle.
 */
const CANDIDATE_LIMIT = 3000;

/**
 * How long an address Google couldn't place is left alone.
 *
 * Google resolves almost anything, so a null result means the address is
 * genuinely unusable — a typo, or a note where a street should be. Retrying it
 * every ten minutes would burn the budget on addresses that will never
 * resolve, but a typo does eventually get corrected, so it is not permanent.
 */
const FAILURE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Enough consecutive transient failures to conclude the problem is Google or
 * the network, not the addresses. Spending the rest of the budget on it just
 * fills the log; the next cycle is ten minutes away.
 */
const FAILURE_ABORT_STREAK = 10;

// Latched so a dead/denied key logs one warning per process, not one per cycle.
let configErrorLogged = false;
// Where the next cycle starts in the queue of unresolved addresses.
let cycleOffset = 0;

type Candidate = { id: number; address: string };

/**
 * Un-pinned bookings worth placing, soonest work first.
 *
 * Upcoming jobs matter most — that's what a crew is being sent to today — so
 * they are taken first and the past is filled in behind them, most recent
 * back. History earns its place on the map too: "where are my clients" is a
 * question about everyone you've cleaned for, not just this week's schedule.
 */
async function loadCandidates(): Promise<Candidate[]> {
  const unpinned = and(
    isNull(bookingsTable.lat),
    isNull(bookingsTable.lng),
    isNotNull(bookingsTable.customerAddress),
  );
  const now = new Date();

  const upcoming = await db
    .select({ id: bookingsTable.id, address: bookingsTable.customerAddress })
    .from(bookingsTable)
    .where(and(unpinned, gte(bookingsTable.scheduledFor, now)))
    .orderBy(asc(bookingsTable.scheduledFor))
    .limit(CANDIDATE_LIMIT);

  const remaining = CANDIDATE_LIMIT - upcoming.length;
  const past =
    remaining > 0
      ? await db
          .select({
            id: bookingsTable.id,
            address: bookingsTable.customerAddress,
          })
          .from(bookingsTable)
          .where(and(unpinned, lt(bookingsTable.scheduledFor, now)))
          .orderBy(desc(bookingsTable.scheduledFor))
          .limit(remaining)
      : [];

  return [...upcoming, ...past]
    .filter((r): r is Candidate => Boolean(r.address))
    .map((r) => ({ id: r.id, address: r.address }));
}

/** Write coordinates onto every booking sitting at one address. */
async function applyToBookings(
  bookingIds: number[],
  coords: { lat: number; lng: number },
): Promise<void> {
  await db
    .update(bookingsTable)
    .set({ lat: coords.lat, lng: coords.lng, geocodedAt: new Date() })
    .where(
      and(
        inArray(bookingsTable.id, bookingIds),
        // Still unresolved — an edit or a concurrent run may have changed it.
        isNull(bookingsTable.lat),
      ),
    );
}

/** Remember what Google said, hit or miss, so the next cycle need not ask. */
async function rememberAddress(
  addressKey: string,
  coords: { lat: number; lng: number } | null,
): Promise<void> {
  await db
    .insert(geocodedAddressesTable)
    .values({
      addressKey,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      attempts: 1,
      checkedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: geocodedAddressesTable.addressKey,
      set: {
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        checkedAt: new Date(),
      },
    });
}

export async function runGeocodeBackfill(): Promise<void> {
  const candidates = await loadCandidates();
  if (candidates.length === 0) return;

  // Fold bookings down to the distinct addresses they share.
  const byAddress = new Map<
    string,
    { address: string; bookingIds: number[] }
  >();
  for (const row of candidates) {
    const key = normalizeAddress(row.address);
    if (!key) continue;
    const entry = byAddress.get(key);
    if (entry) entry.bookingIds.push(row.id);
    else byAddress.set(key, { address: row.address, bookingIds: [row.id] });
  }
  if (byAddress.size === 0) return;

  const keys = [...byAddress.keys()];
  const cached = await db
    .select()
    .from(geocodedAddressesTable)
    .where(inArray(geocodedAddressesTable.addressKey, keys));
  const cachedByKey = new Map(cached.map((c) => [c.addressKey, c]));

  const unknown: string[] = [];
  let fromCache = 0;

  for (const key of keys) {
    const hit = cachedByKey.get(key);
    if (hit && hit.lat !== null && hit.lng !== null) {
      // Free: somebody already paid for this address.
      await applyToBookings(byAddress.get(key)!.bookingIds, {
        lat: hit.lat,
        lng: hit.lng,
      });
      fromCache += 1;
      continue;
    }
    const failedRecently =
      hit && Date.now() - hit.checkedAt.getTime() < FAILURE_TTL_MS;
    if (failedRecently) continue;
    unknown.push(key);
  }

  // Rotate where the budget starts when there's more work than one cycle can
  // take. Otherwise a handful of addresses that fail for some reason we don't
  // cache — a network blip that never stops blipping — would sit at the head
  // of the queue forever and every later address would starve behind them.
  const budget: string[] = [];
  if (unknown.length > 0) {
    const offset = cycleOffset % unknown.length;
    for (let i = 0; i < Math.min(LOOKUPS_PER_CYCLE, unknown.length); i += 1) {
      budget.push(unknown[(offset + i) % unknown.length]!);
    }
    cycleOffset = (offset + budget.length) % unknown.length;
  }

  let resolved = 0;
  let unplaceable = 0;
  let consecutiveFailures = 0;

  for (const key of budget) {
    const entry = byAddress.get(key)!;
    try {
      const coords = await geocodeAddress(entry.address);
      await rememberAddress(key, coords);
      if (!coords) {
        unplaceable += 1;
        continue;
      }
      await applyToBookings(entry.bookingIds, coords);
      resolved += 1;
      consecutiveFailures = 0;
    } catch (err) {
      if (err instanceof GeocodeConfigError) {
        // A missing/denied key means the whole cycle is pointless. Log once,
        // then bail so we don't hammer Google (or the logs) with every row.
        if (!configErrorLogged) {
          logger.warn(
            { err },
            "Geocode backfill paused: Google Maps key missing or denied",
          );
          configErrorLogged = true;
        }
        return;
      }
      // A transient failure on one address shouldn't sink the batch, and must
      // not be cached — leave it unknown so a later cycle retries it.
      logger.warn(
        { err, address: entry.address },
        "Geocode backfill row failed",
      );
      consecutiveFailures += 1;
      if (consecutiveFailures >= FAILURE_ABORT_STREAK) {
        logger.warn(
          { failures: consecutiveFailures },
          "Geocode backfill stopping early: lookups keep failing",
        );
        break;
      }
    }
  }

  if (resolved > 0 || fromCache > 0) {
    logger.info(
      {
        addresses: byAddress.size,
        fromCache,
        resolved,
        unplaceable,
        pending: Math.max(0, unknown.length - budget.length),
      },
      "Geocode backfill cycle complete",
    );
  }
}

let timer: NodeJS.Timeout | null = null;

/**
 * Start the backfill loop. First pass shortly after boot (once startup traffic
 * settles), then every ten minutes.
 */
export function startGeocodeBackfill(): void {
  if (timer) return;
  const run = () => {
    runGeocodeBackfill().catch((err) =>
      logger.error({ err }, "Geocode backfill run failed"),
    );
  };
  setTimeout(run, 90 * 1000).unref();
  timer = setInterval(run, GEOCODE_BACKFILL_INTERVAL_MS);
  timer.unref();
}

/** Test seam: clear the per-process config-error latch and queue position. */
export function _resetBackfillState(): void {
  configErrorLogged = false;
  cycleOffset = 0;
}
