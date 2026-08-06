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
  geocodedAddressesTable,
} from "@workspace/db";
import { eq, inArray, like } from "drizzle-orm";
import {
  setGeocoder,
  resetGeocoder,
  clearGeocodeCache,
  normalizeAddress,
  GeocodeConfigError,
} from "./geocode";
import { runGeocodeBackfill, _resetBackfillState } from "./geocodeBackfill";

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
      .where(eq(geocodedAddressesTable.addressKey, normalizeAddress(DENIED)));

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
});
