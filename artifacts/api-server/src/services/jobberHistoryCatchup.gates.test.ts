/**
 * Catch-up cursor gates, tested with the slice pull stubbed out.
 *
 * The one-time history cursor is durable: once it advances past a day, that
 * day never re-enters the rolling window, so any visit that failed to WRITE
 * during the slice would be lost forever. These tests prove the two gates
 * the integration suite can't reach through a real pull:
 *
 *  - a slice whose pull paginated fine but had persist failures does NOT
 *    advance the cursor;
 *  - a final slice on an UNcertified cycle advances the cursor but withholds
 *    the forever done-stamp until a certified cycle comes around.
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

const syncMock = vi.fn();
vi.mock("./jobberCalendarSync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./jobberCalendarSync")>()),
  syncCompanyCalendar: (...args: unknown[]) => syncMock(...args),
}));

import { db, pool, companiesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { runJobberHistoryCatchup } from "./jobberHistoryCatchup";

const runId = `${Date.now()}_${process.pid}`;
const companyIds: number[] = [];

async function makeCompany(n: number) {
  const [row] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `jhcg_owner_${runId}_${n}`,
      name: `History Gates Co ${runId} ${n}`,
      timezone: "America/Edmonton",
      jobberConnected: true,
      jobberAccessToken: "enc",
      jobberRefreshToken: "enc",
    })
    .returning();
  companyIds.push(row!.id);
  return row!;
}

async function markers(id: number) {
  const [row] = await db
    .select({
      syncedTo: companiesTable.jobberHistorySyncedTo,
      doneAt: companiesTable.jobberHistoryBackfilledAt,
    })
    .from(companiesTable)
    .where(eq(companiesTable.id, id));
  return row!;
}

function sliceResult(over: Partial<Record<string, unknown>> = {}) {
  return {
    imported: 1,
    updated: 0,
    skipped: 0,
    canceled: 0,
    jobberCount: 1,
    hitPageLimit: false,
    pullComplete: true,
    persistFailures: 0,
    ...over,
  };
}

beforeAll(() => {
  // Only Date is faked — the pg driver's real timers must keep working.
  // March 1, 2027: the back edge is Dec 1, 2026, well past the Aug floor.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-03-01T19:00:00Z"));
});

afterEach(() => {
  syncMock.mockReset();
});

afterAll(async () => {
  vi.useRealTimers();
  for (const id of companyIds) {
    await db.delete(companiesTable).where(eq(companiesTable.id, id));
  }
  await pool.end();
});

describe("history catch-up cursor gates", () => {
  it("does not advance past a slice whose visits failed to persist", async () => {
    const company = await makeCompany(1);
    syncMock.mockResolvedValue(
      sliceResult({ pullComplete: true, persistFailures: 2 }),
    );

    const result = await runJobberHistoryCatchup(company, {
      rollingPullComplete: true,
    });

    expect(result.ranSlice).toBe(true);
    expect(result.done).toBe(false);
    const m = await markers(company.id);
    expect(m.syncedTo).toBeNull();
    expect(m.doneAt).toBeNull();

    // Once the writes go through, the SAME slice advances.
    syncMock.mockResolvedValue(sliceResult());
    await runJobberHistoryCatchup(company, { rollingPullComplete: true });
    expect((await markers(company.id)).syncedTo).toBe("2026-08-31");
  });

  it("advances the final slice on an uncertified cycle but saves the stamp for a certified one", async () => {
    const company = await makeCompany(2);
    // Cursor sits one short hop from the back edge (Dec 1, 2026).
    await db
      .update(companiesTable)
      .set({ jobberHistorySyncedTo: "2026-11-25" })
      .where(eq(companiesTable.id, company.id));

    syncMock.mockResolvedValue(sliceResult());
    const uncertified = await runJobberHistoryCatchup(company, {
      rollingPullComplete: false,
    });

    // The slice itself was complete: the cursor moves to the back edge…
    expect(uncertified.ranSlice).toBe(true);
    expect(uncertified.done).toBe(false);
    let m = await markers(company.id);
    expect(m.syncedTo).toBe("2026-12-01");
    // …but the forever-stamp waits: this cycle proved nothing about the
    // rolling window above the back edge.
    expect(m.doneAt).toBeNull();

    // Next certified cycle stamps done without pulling anything.
    const certified = await runJobberHistoryCatchup(company, {
      rollingPullComplete: true,
    });
    expect(certified.done).toBe(true);
    expect(syncMock).toHaveBeenCalledTimes(1);
    m = await markers(company.id);
    expect(m.doneAt).not.toBeNull();
  });
});
