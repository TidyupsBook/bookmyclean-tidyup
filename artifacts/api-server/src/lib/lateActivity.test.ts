/**
 * Real-database race test for the durable "running late" dedupe.
 *
 * The in-process sweep serialization can't help a second server process on
 * the same database, so insertLateEntryOnce must be atomic across clients:
 * the transaction-scoped advisory lock forces concurrent writers into single
 * file, and the second one sees the first's committed row inside the window.
 * An in-memory mock cannot prove that — this runs genuine concurrent
 * transactions against the dev database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, companiesTable, activityTable } from "@workspace/db";
import { insertLateEntryOnce, LATE_ENTRY_DEDUPE_MS } from "./lateActivity";
import { LATE_ACTIVITY_TYPE } from "./lateness";

// Run-unique fixtures: tests share the dev database, and a crashed run must
// not strand rows that collide with the next one.
const RUN = `${Date.now()}-${process.pid}`;
let companyId: number;
// No bookings row is needed — activity.booking_id has no FK — so a large
// run-unique id keeps this test's rows unmistakably its own.
const bookingId = 900_000_000 + (Date.now() % 100_000_000);

function entry() {
  return {
    bookingId,
    type: LATE_ACTIVITY_TYPE,
    message: "Race Cleaner is running late — heading to Race Customer",
  };
}

async function lateRows() {
  return db
    .select()
    .from(activityTable)
    .where(
      and(
        eq(activityTable.companyId, companyId),
        eq(activityTable.type, LATE_ACTIVITY_TYPE),
        eq(activityTable.bookingId, bookingId),
      ),
    );
}

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `late-activity-test-${RUN}`,
      name: `Late Activity Test Co ${RUN}`,
    })
    .returning({ id: companiesTable.id });
  companyId = company!.id;
});

afterAll(async () => {
  await db.delete(activityTable).where(eq(activityTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
});

describe("insertLateEntryOnce", () => {
  it("five concurrent transactions for the same slip write exactly one row", async () => {
    const nowMs = Date.now();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        insertLateEntryOnce(companyId, entry(), nowMs),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await lateRows()).toHaveLength(1);
  });

  it("a slip outside the dedupe window is a new row again", async () => {
    // Pretend the next slip happens after the window has passed.
    const laterMs = Date.now() + LATE_ENTRY_DEDUPE_MS + 1_000;
    expect(await insertLateEntryOnce(companyId, entry(), laterMs)).toBe(true);
    expect(await lateRows()).toHaveLength(2);
  });
});
