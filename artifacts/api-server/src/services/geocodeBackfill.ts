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
import {
  db,
  bookingsTable,
  leadsTable,
  geocodedAddressesTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { geocodeAddress, geocodeCacheKey, GeocodeConfigError } from "./geocode";

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
// True once the one-shot repair sweep has finished so it never runs again.
let repairSweepDone = false;

type Candidate = { id: number; address: string };

/**
 * Return cache keys for addresses that the backfill has actually tried and
 * failed to place. A missing cache row means the address is still pending, so
 * callers can distinguish "not placed yet" from "Google couldn't place it"
 * without exposing the shared cache itself.
 */
export async function loadUnplaceableAddressKeys(
  addresses: readonly string[],
): Promise<Set<string>> {
  const keys = [
    ...new Set(
      addresses
        .map((address) => geocodeCacheKey(address))
        .filter((key) => !key.endsWith(":")),
    ),
  ];
  if (keys.length === 0) return new Set();

  const rows = await db
    .select({
      addressKey: geocodedAddressesTable.addressKey,
      lat: geocodedAddressesTable.lat,
      lng: geocodedAddressesTable.lng,
    })
    .from(geocodedAddressesTable)
    .where(inArray(geocodedAddressesTable.addressKey, keys));

  return new Set(
    rows
      .filter((row) => row.lat === null || row.lng === null)
      .map((row) => row.addressKey),
  );
}

// ---------------------------------------------------------------------------
// One-shot repair sweep: re-verify every already-pinned booking and lead
// ---------------------------------------------------------------------------

/**
 * Collect every pinned booking and resolve which ones need repair.
 *
 * A booking's pin is "correct" when the geocoded_addresses table holds a
 * Canada-restricted result (a `ca:`-prefixed key) for the booking's address,
 * and the stored lat/lng matches that result exactly.
 *
 * Every other case is a pin that predates the Canada restriction (the old
 * geocoder had no `components=country:CA` filter) and may therefore point
 * anywhere in the world:
 *
 *   • No `ca:` cache entry exists      → was pinned by the old geocoder;
 *                                         we don't know if it is right.
 *   • `ca:` entry exists but differs   → the restricted geocoder already
 *                                         found the correct Canadian result
 *                                         but applyToBookings couldn't write
 *                                         it (the guard requires lat IS NULL).
 *   • `ca:` entry exists, coords null  → address can't be placed in Canada;
 *                                         the stored pin must be a wrong one.
 *
 * In all three cases, clearing the pin queues the booking for the normal
 * backfill, which will re-resolve it under the Canada restriction and write
 * the authoritative result (or mark geocodedAt so it is not retried forever).
 *
 * Rows are cleared conditional on the stored lat matching what was read, so
 * a concurrent edit or a parallel repair run can't wipe a coordinate that
 * was already corrected.
 *
 * Returns the number of rows cleared.
 */
async function repairMispinnedBookings(): Promise<number> {
  const pinned = await db
    .select({
      id: bookingsTable.id,
      address: bookingsTable.customerAddress,
      lat: bookingsTable.lat,
      lng: bookingsTable.lng,
    })
    .from(bookingsTable)
    .where(
      and(
        isNotNull(bookingsTable.lat),
        isNotNull(bookingsTable.customerAddress),
      ),
    );

  if (pinned.length === 0) return 0;

  // Map each booking to its Canada-restricted cache key.
  const idToKey = new Map<number, string>();
  const allKeys = new Set<string>();
  for (const row of pinned) {
    if (!row.address) continue;
    const key = geocodeCacheKey(row.address);
    idToKey.set(row.id, key);
    allKeys.add(key);
  }

  const cachedRows = await db
    .select()
    .from(geocodedAddressesTable)
    .where(inArray(geocodedAddressesTable.addressKey, [...allKeys]));
  const byKey = new Map(cachedRows.map((c) => [c.addressKey, c]));

  // Identify which bookings need their pin cleared.
  const toRepair = pinned.filter((row) => {
    const key = idToKey.get(row.id);
    if (!key) return false; // no address — shouldn't happen given the WHERE
    const hit = byKey.get(key);
    if (!hit) return true; // no ca:-keyed entry → pinned before restriction
    if (hit.lat === null) return true; // address can't be placed in Canada
    // ca:-keyed entry exists — only keep the booking if coords match exactly.
    return hit.lat !== row.lat || hit.lng !== row.lng;
  });

  if (toRepair.length === 0) return 0;

  // Clear each row conditional on the lat still matching what we read, so a
  // concurrent write (e.g. another repair run or the backfill) doesn't stomp
  // on a coordinate that was already corrected while we were building the list.
  let cleared = 0;
  for (const row of toRepair) {
    const result = await db
      .update(bookingsTable)
      .set({ lat: null, lng: null, geocodedAt: null })
      .where(
        and(
          eq(bookingsTable.id, row.id),
          eq(bookingsTable.lat, row.lat!),
          eq(bookingsTable.lng, row.lng!),
        ),
      );
    // Drizzle returns rowCount on pg; treat anything > 0 as a successful clear.
    if ((result as unknown as { rowCount: number }).rowCount > 0) cleared += 1;
  }
  return cleared;
}

/**
 * Same logic as repairMispinnedBookings, applied to leads.
 *
 * The lead address is assembled from the four address columns (the same
 * way loadLeadCandidates does) so the cache key matches what the backfill
 * would compute when it later re-resolves the lead.
 */
async function repairMispinnedLeads(): Promise<number> {
  const pinned = await db
    .select({
      id: leadsTable.id,
      streetAddress: leadsTable.streetAddress,
      city: leadsTable.city,
      province: leadsTable.province,
      postCode: leadsTable.postCode,
      lat: leadsTable.lat,
      lng: leadsTable.lng,
    })
    .from(leadsTable)
    .where(isNotNull(leadsTable.lat));

  if (pinned.length === 0) return 0;

  const idToKey = new Map<number, string>();
  const allKeys = new Set<string>();
  for (const row of pinned) {
    const address = [row.streetAddress, row.city, row.province, row.postCode]
      .map((p) => p?.trim())
      .filter(Boolean)
      .join(", ");
    if (!address) continue;
    const key = geocodeCacheKey(address);
    idToKey.set(row.id, key);
    allKeys.add(key);
  }

  const cachedRows = await db
    .select()
    .from(geocodedAddressesTable)
    .where(inArray(geocodedAddressesTable.addressKey, [...allKeys]));
  const byKey = new Map(cachedRows.map((c) => [c.addressKey, c]));

  const toRepair = pinned.filter((row) => {
    const key = idToKey.get(row.id);
    if (!key) return false;
    const hit = byKey.get(key);
    if (!hit) return true;
    if (hit.lat === null) return true;
    return hit.lat !== row.lat || hit.lng !== row.lng;
  });

  if (toRepair.length === 0) return 0;

  let cleared = 0;
  for (const row of toRepair) {
    const result = await db
      .update(leadsTable)
      .set({ lat: null, lng: null, geocodedAt: null })
      .where(
        and(
          eq(leadsTable.id, row.id),
          eq(leadsTable.lat, row.lat!),
          eq(leadsTable.lng, row.lng!),
        ),
      );
    if ((result as unknown as { rowCount: number }).rowCount > 0) cleared += 1;
  }
  return cleared;
}

/**
 * One-shot sweep that re-verifies every already-pinned booking and lead
 * against the Canada-restricted geocoder's cache, and clears any pin that was
 * set before the restriction was in place.
 *
 * A pin is only kept when the geocoded_addresses table holds a `ca:`-prefixed
 * cache entry whose coordinates match what is stored on the row exactly. Any
 * other case — no cache entry, differing coordinates, or an address that the
 * restricted geocoder couldn't place — is cleared so the normal backfill
 * re-resolves it with the current (Canada-only) geocoder.
 *
 * This catches all wrong pins, including those that happen to fall inside
 * Canada's geographic envelope (e.g. Seattle, northern US cities) and would
 * survive a simple bounding-box check.
 *
 * The sweep only clears coordinates; the actual Google calls happen in the
 * normal backfill cycle, which already caps its per-cycle lookup budget.
 */
export async function runGeocodeRepairSweep(): Promise<void> {
  if (repairSweepDone) return;

  const [bookingsCleared, leadsCleared] = await Promise.all([
    repairMispinnedBookings(),
    repairMispinnedLeads(),
  ]);

  repairSweepDone = true;

  if (bookingsCleared > 0 || leadsCleared > 0) {
    logger.info(
      { bookingsCleared, leadsCleared },
      "Geocode repair sweep: cleared unverified pins so backfill can re-resolve them under the Canada restriction",
    );
  }
}

// ---------------------------------------------------------------------------
// Regular backfill
// ---------------------------------------------------------------------------

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

/**
 * Un-pinned leads worth placing, newest first — the Leads page shows new
 * leads on a map and the freshest inquiry is the one being reviewed. The
 * address is the sheet's raw text joined up; when it's just a city (or junk
 * like a province of "Canada"), Google either places it loosely or fails,
 * and the failure is cached like any other address.
 */
async function loadLeadCandidates(): Promise<Candidate[]> {
  const rows = await db
    .select({
      id: leadsTable.id,
      streetAddress: leadsTable.streetAddress,
      city: leadsTable.city,
      province: leadsTable.province,
      postCode: leadsTable.postCode,
    })
    .from(leadsTable)
    .where(and(isNull(leadsTable.lat), isNull(leadsTable.geocodedAt)))
    .orderBy(desc(leadsTable.id))
    .limit(CANDIDATE_LIMIT);
  return rows
    .map((r) => ({
      id: r.id,
      address: [r.streetAddress, r.city, r.province, r.postCode]
        .map((part) => part?.trim())
        .filter(Boolean)
        .join(", "),
    }))
    .filter((r) => r.address.length > 0);
}

/** Write coordinates onto every lead sitting at one address. */
async function applyToLeads(
  leadIds: number[],
  coords: { lat: number; lng: number } | null,
): Promise<void> {
  if (leadIds.length === 0) return;
  await db
    .update(leadsTable)
    .set({
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      // Set even on a miss, so an unusable address isn't re-attempted every
      // cycle. (Bookings rely on the address cache for this; leads also pin
      // it on the row so "still locating" and "couldn't be placed" differ.)
      geocodedAt: new Date(),
    })
    .where(and(inArray(leadsTable.id, leadIds), isNull(leadsTable.geocodedAt)));
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
  const [candidates, leadCandidates] = await Promise.all([
    loadCandidates(),
    loadLeadCandidates(),
  ]);
  if (candidates.length === 0 && leadCandidates.length === 0) return;

  // Fold bookings and leads down to the distinct addresses they share — the
  // house that inquired through a lead ad and later booked is one address,
  // one Google lookup, pins for both.
  const byAddress = new Map<
    string,
    { address: string; bookingIds: number[]; leadIds: number[] }
  >();
  const entryFor = (key: string, address: string) => {
    let entry = byAddress.get(key);
    if (!entry) {
      entry = { address, bookingIds: [], leadIds: [] };
      byAddress.set(key, entry);
    }
    return entry;
  };
  // Folded (and stored) under geocodeCacheKey, which carries the Canada
  // restriction: rows cached before lookups were locked to Canada never
  // match, so a stale US result re-resolves instead of being replayed.
  for (const row of candidates) {
    const key = geocodeCacheKey(row.address);
    if (!key.endsWith(":")) {
      entryFor(key, row.address).bookingIds.push(row.id);
    }
  }
  for (const row of leadCandidates) {
    const key = geocodeCacheKey(row.address);
    if (!key.endsWith(":")) {
      entryFor(key, row.address).leadIds.push(row.id);
    }
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
      const entry = byAddress.get(key)!;
      const coords = { lat: hit.lat, lng: hit.lng };
      await applyToBookings(entry.bookingIds, coords);
      await applyToLeads(entry.leadIds, coords);
      fromCache += 1;
      continue;
    }
    const failedRecently =
      hit && Date.now() - hit.checkedAt.getTime() < FAILURE_TTL_MS;
    if (failedRecently) {
      // The cache already knows this address doesn't resolve; mark the leads
      // so they stop being candidates (bookings key off the cache instead).
      await applyToLeads(byAddress.get(key)!.leadIds, null);
      continue;
    }
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
        await applyToLeads(entry.leadIds, null);
        unplaceable += 1;
        continue;
      }
      await applyToBookings(entry.bookingIds, coords);
      await applyToLeads(entry.leadIds, coords);
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
 *
 * The one-shot repair sweep runs before the first normal cycle so that any
 * bookings or leads pinned to US coordinates (geocoded before the Canada
 * restriction was added) are cleared and re-queued immediately. The repair
 * sweep only clears coordinates; the actual Google calls are handled by the
 * normal backfill and respect its per-cycle budget.
 */
export function startGeocodeBackfill(): void {
  if (timer) return;
  const run = () => {
    runGeocodeBackfill().catch((err) =>
      logger.error({ err }, "Geocode backfill run failed"),
    );
  };
  // Kick off the repair sweep once, shortly after boot, then start the
  // regular cycle. Running the sweep first means the normal backfill that
  // follows immediately has the freshly-cleared rows in its candidate set.
  setTimeout(() => {
    runGeocodeRepairSweep()
      .catch((err) => logger.error({ err }, "Geocode repair sweep failed"))
      .finally(run);
  }, 90 * 1000).unref();
  timer = setInterval(run, GEOCODE_BACKFILL_INTERVAL_MS);
  timer.unref();
}

/** Test seam: clear the per-process config-error latch, queue position, and repair-sweep guard. */
export function _resetBackfillState(): void {
  configErrorLogged = false;
  cycleOffset = 0;
  repairSweepDone = false;
}
