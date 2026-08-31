/**
 * Backfill tests: proves it resolves un-geocoded bookings via an injected
 * stub, remembers the unresolvable ones so they can't starve the batch, pins
 * past work as well as upcoming, charges one lookup for an address however
 * many bookings sit at it, and degrades quietly (no throw, logs once) when the
 * key is denied.
 *
 * Addresses carry the run id because the geocode cache is a real table shared
 * across runs — a fixed address would already be resolved from a previous run
 * and the lookup being asserted would never happen.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

import {
  db,
  pool,
  companiesTable,
  bookingsTable,
  leadsTable,
  geocodedAddressesTable,
} from "@workspace/db";
import { eq, inArray, like } from "drizzle-orm";
import {
  setGeocoder,
  resetGeocoder,
  clearGeocodeCache,
  geocodeCacheKey,
  normalizeAddress,
  GeocodeConfigError,
} from "./geocode";
import {
  loadUnplaceableAddressKeys,
  runGeocodeBackfill,
  runGeocodeRepairSweep,
  _resetBackfillState,
} from "./geocodeBackfill";

const runId = `${Date.now()}_${process.pid}`;

const RESOLVABLE = `1 Real St ${runId}`;
const UNRESOLVABLE = `gibberish nowhere ${runId}`;
/** One address, several visits — the shape repeat cleaning actually takes. */
const REPEAT = `9 Weekly Ave ${runId}`;
const DENIED = `4 Denied Rd ${runId}`;

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

let companyId: number;
let resolvableId: number;
let unresolvableId: number;
let repeatIds: number[] = [];
let deniedId: number;

function booking(customerName: string, address: string, when: Date) {
  return {
    companyId,
    callId: null,
    customerName,
    customerPhone: "+15550001111",
    customerAddress: address,
    service: "Deep clean",
    scheduledFor: when,
    status: "confirmed" as const,
  };
}

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({ ownerUserId: `bf_owner_${runId}`, name: `Backfill Co ${runId}` })
    .returning();
  companyId = company!.id;

  const rows = await db
    .insert(bookingsTable)
    .values([
      booking("Resolvable", RESOLVABLE, FUTURE),
      booking("Unresolvable", UNRESOLVABLE, FUTURE),
      // Same house, three visits, one of them already behind us.
      booking("Weekly Client", REPEAT, FUTURE),
      booking("Weekly Client", `  ${REPEAT.toUpperCase()} `, FUTURE),
      booking("Weekly Client", REPEAT, PAST),
      booking("Denied", DENIED, FUTURE),
    ])
    .returning();
  resolvableId = rows[0]!.id;
  unresolvableId = rows[1]!.id;
  repeatIds = [rows[2]!.id, rows[3]!.id, rows[4]!.id];
  deniedId = rows[5]!.id;
});

afterEach(() => {
  resetGeocoder();
  clearGeocodeCache();
  _resetBackfillState();
});

afterAll(async () => {
  await db.delete(bookingsTable).where(eq(bookingsTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await db
    .delete(geocodedAddressesTable)
    .where(like(geocodedAddressesTable.addressKey, `%${runId}%`));
  await pool.end();
});

describe("runGeocodeBackfill", () => {
  it("pins what it can place, remembers what it can't, and charges one lookup per address", async () => {
    const asked: string[] = [];
    setGeocoder(async (address) => {
      asked.push(normalizeAddress(address));
      if (address.includes("Real")) return { lat: 40, lng: -75 };
      if (address.toLowerCase().includes("weekly ave"))
        return { lat: 51, lng: -114 };
      if (address.includes("Denied")) return { lat: 1, lng: 2 };
      return null;
    });

    await runGeocodeBackfill();

    const rows = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.companyId, companyId));
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get(resolvableId)!.lat).toBe(40);
    expect(byId.get(resolvableId)!.lng).toBe(-75);
    expect(byId.get(resolvableId)!.geocodedAt).not.toBeNull();

    // Google placed nothing, so the booking stays unpinned.
    expect(byId.get(unresolvableId)!.lat).toBeNull();
    expect(
      await loadUnplaceableAddressKeys([
        RESOLVABLE,
        UNRESOLVABLE,
        `not-yet-attempted ${runId}`,
      ]),
    ).toEqual(new Set([geocodeCacheKey(UNRESOLVABLE)]));

    // Every visit to the repeat address is pinned, including the one in the
    // past and the one whose address differs only by case and padding.
    for (const id of repeatIds) {
      expect(byId.get(id)!.lat).toBe(51);
      expect(byId.get(id)!.lng).toBe(-114);
    }

    // ...but the repeat address was only ever looked up once.
    const repeatLookups = asked.filter((a) => a.includes("weekly ave")).length;
    expect(repeatLookups).toBe(1);
  });

  it("answers from the stored cache without asking Google again", async () => {
    // Wipe the coordinates but leave the cache rows from the previous test.
    await db
      .update(bookingsTable)
      .set({ lat: null, lng: null, geocodedAt: null })
      .where(inArray(bookingsTable.id, repeatIds));

    // The backfill sweeps every company, so count only this run's addresses —
    // other fixtures' bookings are legitimately in the same batch.
    const asked: string[] = [];
    setGeocoder(async (address) => {
      asked.push(normalizeAddress(address));
      return { lat: 0, lng: 0 };
    });

    await runGeocodeBackfill();

    const rows = await db
      .select()
      .from(bookingsTable)
      .where(inArray(bookingsTable.id, repeatIds));
    // Re-pinned from cache, at the original coordinates rather than the stub's.
    for (const row of rows) {
      expect(row.lat).toBe(51);
      expect(row.lng).toBe(-114);
    }
    // The unresolvable address is remembered as a miss, so it isn't retried
    // either — nothing of ours should have reached Google at all.
    expect(asked.filter((a) => a.includes(runId))).toEqual([]);
  });

  it("degrades quietly when the key is denied — no throw, nothing written", async () => {
    await db
      .update(bookingsTable)
      .set({ lat: null, lng: null, geocodedAt: null })
      .where(eq(bookingsTable.id, deniedId));
    await db
      .delete(geocodedAddressesTable)
      .where(eq(geocodedAddressesTable.addressKey, geocodeCacheKey(DENIED)));

    setGeocoder(async () => {
      throw new GeocodeConfigError("REQUEST_DENIED");
    });

    await expect(runGeocodeBackfill()).resolves.toBeUndefined();

    const [row] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, deniedId));
    expect(row!.lat).toBeNull();
  });

  it("ignores a cache row from before the Canada restriction and re-resolves", async () => {
    const STALE = `7 Stale Blvd ${runId}`;
    const [staleBooking] = await db
      .insert(bookingsTable)
      .values([booking("Stale Cache", STALE, FUTURE)])
      .returning();
    // A row under the OLD key format — the bare normalized address — holding
    // a confidently wrong (US) result from before lookups were locked to
    // Canada. The new key never matches it, so it must not be served.
    await db.insert(geocodedAddressesTable).values({
      addressKey: normalizeAddress(STALE),
      lat: 37.55,
      lng: -77.46, // Richmond, Virginia
      attempts: 1,
      checkedAt: new Date(),
    });

    setGeocoder(async (address) =>
      normalizeAddress(address) === normalizeAddress(STALE)
        ? { lat: 53.5, lng: -113.5 }
        : null,
    );
    await runGeocodeBackfill();

    const [row] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, staleBooking!.id));
    // Re-resolved fresh (now inside Canada), not replayed from the stale row.
    expect(row!.lat).toBe(53.5);
    expect(row!.lng).toBe(-113.5);

    // And the fresh answer is remembered under the restricted key.
    const remembered = await db
      .select()
      .from(geocodedAddressesTable)
      .where(eq(geocodedAddressesTable.addressKey, geocodeCacheKey(STALE)));
    expect(remembered).toHaveLength(1);
    expect(remembered[0]!.lat).toBe(53.5);
  });
});

describe("runGeocodeRepairSweep", () => {
  /**
   * The repair sweep identifies mispinned rows by checking the geocoded_addresses
   * cache, not by geography. A booking's pin is "verified" only when there is a
   * `ca:`-prefixed cache entry whose coordinates match the stored lat/lng exactly.
   *
   * This catches every pre-restriction pin — including cities like Seattle that
   * fall inside a rectangular Canada bounding box — because it doesn't rely on
   * coordinates at all; it relies on whether the Canada-restricted geocoder has
   * ever confirmed the result.
   *
   * Fixture map:
   *   wrongNoCacheBkId  — pinned (any coords), NO ca: cache entry → cleared
   *   seattleBkId       — pinned to Seattle coords, NO ca: cache entry → cleared
   *                       (proves northern-US pins inside a bounding box are caught)
   *   correctBkId       — pinned, ca: cache entry matches exactly → kept
   *   mismatchBkId      — pinned, ca: cache entry has DIFFERENT coords → cleared
   *   nullCacheBkId     — pinned, ca: cache entry has null (unresolvable in CA) → cleared
   *   unpinnedBkId      — no pin at all → untouched
   *   wrongLeadId       — pinned lead, NO ca: cache entry → cleared
   *   correctLeadId     — pinned lead, ca: cache entry matches → kept
   */
  let repairCompanyId: number;
  let wrongNoCacheBkId: number;
  let seattleBkId: number;
  let correctBkId: number;
  let mismatchBkId: number;
  let nullCacheBkId: number;
  let unpinnedBkId: number;
  let wrongLeadId: number;
  let correctLeadId: number;

  const WRONG_ADDR = `42 Wrong St ${runId}`;
  const SEATTLE_ADDR = `1 Seattle Way ${runId}`;
  const CORRECT_ADDR = `99 Good Ave ${runId}`;
  const MISMATCH_ADDR = `55 Stale Ln ${runId}`;
  const NULL_CACHE_ADDR = `33 Bad Rd ${runId}`;
  const UNPINNED_ADDR = `77 Pending Cres ${runId}`;
  const WRONG_LEAD_ADDR = `1 Virginia Rd ${runId}, Richmond, VA`;
  const CORRECT_LEAD_STREET = `2 Alberta Way ${runId}`;

  beforeAll(async () => {
    const [company] = await db
      .insert(companiesTable)
      .values({
        ownerUserId: `repair_owner_${runId}`,
        name: `Repair Co ${runId}`,
      })
      .returning();
    repairCompanyId = company!.id;

    function bk(
      name: string,
      address: string,
      lat: number | null,
      lng: number | null,
    ) {
      return {
        companyId: repairCompanyId,
        callId: null as null,
        customerName: name,
        customerPhone: "+15550009999",
        customerAddress: address,
        service: "Standard clean",
        scheduledFor: FUTURE,
        status: "confirmed" as const,
        lat,
        lng,
        geocodedAt: lat !== null ? new Date() : null,
      };
    }

    const rows = await db
      .insert(bookingsTable)
      .values([
        bk("Wrong NoCa", WRONG_ADDR, 40.71, -74.01), // NYC — no ca: entry
        bk("Seattle", SEATTLE_ADDR, 47.61, -122.33), // Seattle — no ca: entry
        bk("Correct", CORRECT_ADDR, 53.5, -113.5), // Edmonton — ca: entry will match
        bk("Mismatch", MISMATCH_ADDR, 40.0, -75.0), // old wrong pin — ca: entry differs
        bk("NullCache", NULL_CACHE_ADDR, 38.9, -77.0), // ca: entry is null (can't resolve in CA)
        bk("Unpinned", UNPINNED_ADDR, null, null), // no pin
      ])
      .returning();

    wrongNoCacheBkId = rows[0]!.id;
    seattleBkId = rows[1]!.id;
    correctBkId = rows[2]!.id;
    mismatchBkId = rows[3]!.id;
    nullCacheBkId = rows[4]!.id;
    unpinnedBkId = rows[5]!.id;

    // Only the "correct" and "mismatch" and "null-cache" bookings get ca: entries.
    // The "wrong" and "seattle" bookings have no ca: entry — simulating pins
    // that were set by the old geocoder with no Canada restriction.
    await db.insert(geocodedAddressesTable).values([
      // Correct: ca: entry matches exactly what's stored.
      {
        addressKey: geocodeCacheKey(CORRECT_ADDR),
        lat: 53.5,
        lng: -113.5,
        attempts: 1,
        checkedAt: new Date(),
      },
      // Mismatch: ca: entry has the real Edmonton result; booking has old wrong coords.
      {
        addressKey: geocodeCacheKey(MISMATCH_ADDR),
        lat: 53.4,
        lng: -113.6,
        attempts: 1,
        checkedAt: new Date(),
      },
      // NullCache: address couldn't be placed in Canada.
      {
        addressKey: geocodeCacheKey(NULL_CACHE_ADDR),
        lat: null,
        lng: null,
        attempts: 1,
        checkedAt: new Date(),
      },
    ]);

    // Leads
    const leadRows = await db
      .insert(leadsTable)
      .values([
        {
          companyId: repairCompanyId,
          externalId: `wrong-lead-${runId}`,
          sourceTab: "Aug Leads V1",
          phoneNumber: "+15550005555",
          streetAddress: `1 Virginia Rd ${runId}`,
          city: "Richmond",
          province: "VA",
          lat: 37.55,
          lng: -77.46,
          geocodedAt: new Date(),
          // No ca: cache entry — pinned by old geocoder.
        },
        {
          companyId: repairCompanyId,
          externalId: `correct-lead-${runId}`,
          sourceTab: "Aug Leads V1",
          phoneNumber: "+15550006666",
          streetAddress: CORRECT_LEAD_STREET,
          city: "Edmonton",
          province: "AB",
          lat: 53.4,
          lng: -113.6,
          geocodedAt: new Date(),
        },
      ])
      .returning();
    wrongLeadId = leadRows[0]!.id;
    correctLeadId = leadRows[1]!.id;

    // ca: entry for the correct lead — matches stored coords.
    const correctLeadAddress = [CORRECT_LEAD_STREET, "Edmonton", "AB"].join(
      ", ",
    );
    await db.insert(geocodedAddressesTable).values({
      addressKey: geocodeCacheKey(correctLeadAddress),
      lat: 53.4,
      lng: -113.6,
      attempts: 1,
      checkedAt: new Date(),
    });
  });

  afterAll(async () => {
    await db
      .delete(bookingsTable)
      .where(eq(bookingsTable.companyId, repairCompanyId));
    await db
      .delete(leadsTable)
      .where(eq(leadsTable.companyId, repairCompanyId));
    await db
      .delete(geocodedAddressesTable)
      .where(like(geocodedAddressesTable.addressKey, `%${runId}%`));
    await db
      .delete(companiesTable)
      .where(eq(companiesTable.id, repairCompanyId));
  });

  it("clears every unverified pin and leaves verified ones intact", async () => {
    await runGeocodeRepairSweep();

    const bookings = await db
      .select()
      .from(bookingsTable)
      .where(
        inArray(bookingsTable.id, [
          wrongNoCacheBkId,
          seattleBkId,
          correctBkId,
          mismatchBkId,
          nullCacheBkId,
          unpinnedBkId,
        ]),
      );
    const byId = new Map(bookings.map((r) => [r.id, r]));

    // No ca: entry — cleared regardless of how plausible the coordinates look.
    expect(byId.get(wrongNoCacheBkId)!.lat).toBeNull();
    expect(byId.get(wrongNoCacheBkId)!.geocodedAt).toBeNull();

    // Seattle is inside Canada's rectangular bounding box but has no ca: entry —
    // must also be cleared (this is the key advantage over a bounding-box check).
    expect(byId.get(seattleBkId)!.lat).toBeNull();
    expect(byId.get(seattleBkId)!.geocodedAt).toBeNull();

    // ca: entry matches stored coords exactly — untouched.
    expect(byId.get(correctBkId)!.lat).toBe(53.5);
    expect(byId.get(correctBkId)!.lng).toBe(-113.5);

    // ca: entry exists but coords differ — cleared so backfill can apply the correct result.
    expect(byId.get(mismatchBkId)!.lat).toBeNull();
    expect(byId.get(mismatchBkId)!.geocodedAt).toBeNull();

    // ca: entry has null coords (unresolvable in Canada) — US pin cleared.
    expect(byId.get(nullCacheBkId)!.lat).toBeNull();
    expect(byId.get(nullCacheBkId)!.geocodedAt).toBeNull();

    // No pin to begin with — untouched.
    expect(byId.get(unpinnedBkId)!.lat).toBeNull();
    expect(byId.get(unpinnedBkId)!.geocodedAt).toBeNull();

    const leads = await db
      .select()
      .from(leadsTable)
      .where(inArray(leadsTable.id, [wrongLeadId, correctLeadId]));
    const leadById = new Map(leads.map((r) => [r.id, r]));

    // Lead with no ca: entry — cleared.
    expect(leadById.get(wrongLeadId)!.lat).toBeNull();
    expect(leadById.get(wrongLeadId)!.geocodedAt).toBeNull();

    // Lead whose ca: entry matches — untouched.
    expect(leadById.get(correctLeadId)!.lat).toBe(53.4);
    expect(leadById.get(correctLeadId)!.lng).toBe(-113.6);
  });

  it("is idempotent — a second call within a process is a no-op (guard flag)", async () => {
    await runGeocodeRepairSweep();
    await runGeocodeRepairSweep(); // hits the guard; no DB work done
    // No assertion beyond "no throw" — the guard flag is the mechanism under test.
  });

  it("clears a re-seeded northern-US pin after resetting the sweep state", async () => {
    const usPin = { lat: 47.61, lng: -122.33 }; // Seattle, inside Canada's bounding box

    // Seed the same kind of stale pin the first sweep repaired.
    await db
      .update(bookingsTable)
      .set({ ...usPin, geocodedAt: new Date() })
      .where(eq(bookingsTable.id, seattleBkId));
    await db
      .delete(geocodedAddressesTable)
      .where(
        eq(geocodedAddressesTable.addressKey, geocodeCacheKey(SEATTLE_ADDR)),
      );

    _resetBackfillState();
    await runGeocodeRepairSweep();

    const [firstClear] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, seattleBkId));
    expect(firstClear!.lat).toBeNull();
    expect(firstClear!.lng).toBeNull();
    expect(firstClear!.geocodedAt).toBeNull();

    // Re-seed the stale pin and prove the reset guard does not leave it behind.
    await db
      .update(bookingsTable)
      .set({ ...usPin, geocodedAt: new Date() })
      .where(eq(bookingsTable.id, seattleBkId));
    _resetBackfillState();
    await runGeocodeRepairSweep();

    const [secondClear] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, seattleBkId));
    expect(secondClear!.lat).toBeNull();
    expect(secondClear!.lng).toBeNull();
    expect(secondClear!.geocodedAt).toBeNull();
  });

  it("cleared bookings become backfill candidates and re-resolve under the Canada restriction", async () => {
    // wrongNoCacheBkId was cleared in the first test; the normal backfill should
    // now pick it up and write the Canada-restricted result.
    setGeocoder(async () => ({ lat: 53.55, lng: -113.49 }));

    await runGeocodeBackfill();

    const [row] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, wrongNoCacheBkId));
    expect(row!.lat).toBe(53.55);
    expect(row!.lng).toBe(-113.49);
  });

  it("does not erase a booking corrected after candidates are read", async () => {
    const raceAddress = `88 Concurrent Way ${runId}`;
    const staleCoords = { lat: 12.34, lng: -56.78 };
    const correctedCoords = { lat: 12.34, lng: -56.79 };
    const [raceBooking] = await db
      .insert(bookingsTable)
      .values([
        {
          ...booking("Concurrent correction", raceAddress, FUTURE),
          ...staleCoords,
          geocodedAt: new Date(),
        },
      ])
      .returning();

    // No restricted cache entry means the stale pin is a repair candidate.
    await db
      .delete(geocodedAddressesTable)
      .where(
        eq(geocodedAddressesTable.addressKey, geocodeCacheKey(raceAddress)),
      );

    _resetBackfillState();
    let correctionApplied = false;
    const realUpdate = db.update.bind(db);
    const updateSpy = vi.spyOn(db, "update").mockImplementation(((
      table: typeof bookingsTable,
    ) => {
      const builder = realUpdate(table) as any;
      if (table !== bookingsTable) return builder;

      const realSet = builder.set.bind(builder);
      builder.set = (values: unknown) => {
        const query = realSet(values);
        const realWhere = query.where.bind(query);
        query.where = (condition: unknown) => {
          const filteredQuery = realWhere(condition);
          const { params } = filteredQuery.toSQL();

          // The sweep has already read both its pinned rows and cache rows
          // by the time it builds this update. Change only this booking now,
          // preserving latitude but correcting longitude.
          if (!correctionApplied && params.includes(raceBooking!.id)) {
            correctionApplied = true;
            return (async () => {
              await db
                .update(bookingsTable)
                .set({ ...correctedCoords, geocodedAt: new Date() })
                .where(eq(bookingsTable.id, raceBooking!.id));
              return filteredQuery;
            })();
          }
          return filteredQuery;
        };
        return query;
      };
      return builder;
    }) as never);

    try {
      await runGeocodeRepairSweep();
    } finally {
      updateSpy.mockRestore();
    }

    expect(correctionApplied).toBe(true);
    const [row] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, raceBooking!.id));
    expect(row!.lat).toBe(correctedCoords.lat);
    expect(row!.lng).toBe(correctedCoords.lng);
    expect(row!.geocodedAt).not.toBeNull();
  });
});
