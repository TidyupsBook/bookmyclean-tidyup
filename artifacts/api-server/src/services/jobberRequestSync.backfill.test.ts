/**
 * Jobber request BACKFILL tests — the resumable first pull.
 *
 * A company can hold more post-floor requests than one run's page cap
 * (MAX_PAGES × PAGE_SIZE = 1,000). What's proved here is that such a company
 * makes durable progress instead of stalling forever:
 *
 *  - a capped first pull persists Jobber's pagination cursor (with the exact
 *    filter it was issued under) and the next run RESUMES from it rather
 *    than re-reading the same first pages,
 *  - the completing run sets the watermark back to when the backfill BEGAN,
 *    so mid-backfill updates are re-read by the first incremental pull, and
 *    clears all three backfill markers,
 *  - the upgrade path: a company that already carries a watermark stays on
 *    the incremental updatedAt filter — it is never restarted at the floor
 *    and never grows backfill markers. (No post-floor gap can hide behind an
 *    existing watermark: watermarks only ever come from complete pulls, and
 *    pre-floor-pin complete first pulls looked back 365 days — far past the
 *    August 2026 floor.)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

const graphqlMock = vi.fn();
vi.mock("../lib/jobber", () => ({
  getValidAccessToken: vi.fn(async () => "test-token"),
  jobberGraphql: (...args: unknown[]) => graphqlMock(...args),
}));

import {
  db,
  pool,
  companiesTable,
  bookingsTable,
  clientsTable,
  leadsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  syncCompanyJobberRequests,
  type JobberRequestNode,
} from "./jobberRequestSync";
import { JOBBER_HISTORY_FLOOR } from "../lib/jobberHistory";

const MAX_PAGES = 40;
const OVERLAP_MS = 10 * 60 * 1000;

const runId = `${Date.now()}_${process.pid}_bf`;
const companyIds: number[] = [];

function node(n: number): JobberRequestNode {
  return {
    id: `bfreq_${runId}_${n}`,
    title: `Backfill clean ${n}`,
    requestStatus: "new",
    createdAt: new Date(Date.UTC(2026, 7, 2, 12, 0, n)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 7, 2, 12, 30, n)).toISOString(),
    jobberWebUri: null,
    contactName: `Backfill Customer ${n}`,
    phone: `+1555000${String(7000 + n)}`,
    email: null,
    client: null,
    property: null,
  };
}

function page(nodes: JobberRequestNode[], endCursor: string | null) {
  return {
    requests: {
      nodes,
      pageInfo: { hasNextPage: endCursor !== null, endCursor },
    },
  };
}

async function makeCompany(suffix: string) {
  const [row] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `jrsbf_owner_${runId}_${suffix}`,
      name: `Request Backfill Co ${runId} ${suffix}`,
      timezone: "America/Edmonton",
      jobberConnected: true,
      jobberAccessToken: "enc",
      jobberRefreshToken: "enc",
    })
    .returning();
  companyIds.push(row!.id);
  return row!;
}

async function companyRow(id: number) {
  const [row] = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.id, id));
  return row!;
}

/** The GraphQL variables of the i-th call this run (0-based). */
function callVars(i: number): {
  filter: { updatedAt?: { after: string } };
  after: string | null;
} {
  return graphqlMock.mock.calls[i]![2] as never;
}

beforeAll(async () => {
  // The suite drives the mock per test; nothing shared to set up beyond
  // companies, created inside each test for isolation.
});

afterAll(async () => {
  if (companyIds.length > 0) {
    await db
      .delete(bookingsTable)
      .where(inArray(bookingsTable.companyId, companyIds));
    await db
      .delete(leadsTable)
      .where(inArray(leadsTable.companyId, companyIds));
    await db
      .delete(clientsTable)
      .where(inArray(clientsTable.companyId, companyIds));
    await db
      .delete(companiesTable)
      .where(inArray(companiesTable.id, companyIds));
  }
  await pool.end();
});

describe("request backfill survives the page cap", () => {
  it("a >MAX_PAGES first pull resumes from the saved cursor and completes across runs", async () => {
    const co = await makeCompany("cap");

    // ---- Run 1: Jobber offers more pages than the cap allows.
    graphqlMock.mockReset();
    for (let p = 0; p < MAX_PAGES; p++) {
      graphqlMock.mockResolvedValueOnce(page([node(p)], `cursor_${p + 1}`));
    }
    const before = Date.now();
    const run1 = await syncCompanyJobberRequests(co);
    expect(run1.complete).toBe(false);
    expect(run1.imported).toBe(MAX_PAGES); // capped runs still land their rows
    expect(graphqlMock).toHaveBeenCalledTimes(MAX_PAGES);

    // The first request started the chain at the pinned floor, cursor-less.
    expect(callVars(0).after).toBeNull();
    expect(callVars(0).filter.updatedAt?.after).toBe(
      JOBBER_HISTORY_FLOOR.toISOString(),
    );

    // Capped: watermark withheld, but the cursor chain is durable.
    const afterRun1 = await companyRow(co.id);
    expect(afterRun1.jobberRequestsSyncedThrough).toBeNull();
    expect(afterRun1.jobberRequestsBackfillEndCursor).toBe(
      `cursor_${MAX_PAGES}`,
    );
    expect(afterRun1.jobberRequestsBackfillFilterFloor).toBe(
      JOBBER_HISTORY_FLOOR.toISOString(),
    );
    const startedAt = afterRun1.jobberRequestsBackfillStartedAt;
    expect(startedAt).not.toBeNull();
    expect(startedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);

    // ---- Run 2: resumes mid-chain — same filter, saved cursor — and finishes.
    graphqlMock.mockReset();
    graphqlMock.mockResolvedValueOnce(page([node(MAX_PAGES)], null));
    const run2 = await syncCompanyJobberRequests(await companyRow(co.id));
    expect(run2.complete).toBe(true);
    expect(graphqlMock).toHaveBeenCalledTimes(1);
    expect(callVars(0).after).toBe(`cursor_${MAX_PAGES}`);
    expect(callVars(0).filter.updatedAt?.after).toBe(
      JOBBER_HISTORY_FLOOR.toISOString(),
    );

    // Watermark reaches back to the backfill's START (minus overlap), so the
    // first incremental pull re-reads everything updated mid-backfill; the
    // markers are cleared.
    const done = await companyRow(co.id);
    expect(done.jobberRequestsSyncedThrough).not.toBeNull();
    expect(done.jobberRequestsSyncedThrough!.getTime()).toBe(
      startedAt!.getTime() - OVERLAP_MS,
    );
    expect(done.jobberRequestsBackfillStartedAt).toBeNull();
    expect(done.jobberRequestsBackfillEndCursor).toBeNull();
    expect(done.jobberRequestsBackfillFilterFloor).toBeNull();

    // Every page's rows landed exactly once across the two runs.
    const rows = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.companyId, co.id));
    expect(rows).toHaveLength(MAX_PAGES + 1);
  });

  it("a malformed page mid-chain keeps the previous cursor, so nothing is skipped", async () => {
    const co = await makeCompany("malformed");

    // Run 1 caps normally, persisting cursor_40.
    graphqlMock.mockReset();
    for (let p = 0; p < MAX_PAGES; p++) {
      graphqlMock.mockResolvedValueOnce(page([node(100 + p)], `mcur_${p + 1}`));
    }
    await syncCompanyJobberRequests(co);
    expect((await companyRow(co.id)).jobberRequestsBackfillEndCursor).toBe(
      `mcur_${MAX_PAGES}`,
    );

    // Run 2 gets garbage: no completeness claimed, cursor NOT advanced —
    // the next run re-fetches from the same place rather than past it.
    graphqlMock.mockReset();
    graphqlMock.mockResolvedValueOnce({ requests: null });
    const run2 = await syncCompanyJobberRequests(await companyRow(co.id));
    expect(run2.complete).toBe(false);
    const after = await companyRow(co.id);
    expect(after.jobberRequestsSyncedThrough).toBeNull();
    expect(after.jobberRequestsBackfillEndCursor).toBe(`mcur_${MAX_PAGES}`);
  });
});

describe("a failed booking write is retried, never stranded", () => {
  /** Make the run's first booking insert blow up, like a transient DB error. */
  function failFirstInsert() {
    const spy = vi.spyOn(db, "insert");
    spy.mockImplementationOnce(() => {
      throw new Error("db hiccup");
    });
    return spy;
  }

  it("a capped run with a failed write withholds the cursor; the clean retry re-reads the pages and lands every row", async () => {
    const co = await makeCompany("gate-cap");

    // ---- Run 1: caps at MAX_PAGES, but the very first booking write fails.
    graphqlMock.mockReset();
    for (let p = 0; p < MAX_PAGES; p++) {
      graphqlMock.mockResolvedValueOnce(page([node(200 + p)], `gcur_${p + 1}`));
    }
    const spy = failFirstInsert();
    const run1 = await syncCompanyJobberRequests(co);
    spy.mockRestore();
    expect(run1.complete).toBe(false);
    expect(run1.imported).toBe(MAX_PAGES - 1); // one node's write failed

    // Cursor withheld — persisting it would put the failed request behind
    // it forever. The backfill start survives; it marks when the window
    // opened, not progress.
    const afterRun1 = await companyRow(co.id);
    expect(afterRun1.jobberRequestsBackfillEndCursor).toBeNull();
    expect(afterRun1.jobberRequestsBackfillFilterFloor).toBeNull();
    expect(afterRun1.jobberRequestsSyncedThrough).toBeNull();
    expect(afterRun1.jobberRequestsBackfillStartedAt).not.toBeNull();

    // ---- Run 2: clean. The chain restarts at the floor (nothing was saved),
    // re-reads the same pages — upserts deduplicate — and completes. Jobber
    // now fits the same rows in MAX_PAGES pages (the last one final).
    graphqlMock.mockReset();
    for (let p = 0; p < MAX_PAGES - 1; p++) {
      graphqlMock.mockResolvedValueOnce(
        page([node(200 + p)], `gcur2_${p + 1}`),
      );
    }
    graphqlMock.mockResolvedValueOnce(page([node(200 + MAX_PAGES - 1)], null));
    const run2 = await syncCompanyJobberRequests(await companyRow(co.id));
    expect(run2.complete).toBe(true);
    expect(callVars(0).after).toBeNull();
    expect(callVars(0).filter.updatedAt?.after).toBe(
      JOBBER_HISTORY_FLOOR.toISOString(),
    );

    const done = await companyRow(co.id);
    expect(done.jobberRequestsSyncedThrough).not.toBeNull();
    expect(done.jobberRequestsBackfillEndCursor).toBeNull();
    // Every node — including the one whose write failed in run 1 — landed.
    const rows = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.companyId, co.id));
    expect(rows).toHaveLength(MAX_PAGES);
  });

  it("a fully-read pull with a failed write withholds the watermark; the clean retry advances it", async () => {
    const co = await makeCompany("gate-final");

    graphqlMock.mockReset();
    graphqlMock.mockResolvedValueOnce(page([node(300)], null));
    const spy = failFirstInsert();
    const run1 = await syncCompanyJobberRequests(co);
    spy.mockRestore();
    // Every page was read but not every row landed — the run must not
    // report itself complete nor advance the watermark.
    expect(run1.complete).toBe(false);
    const afterRun1 = await companyRow(co.id);
    expect(afterRun1.jobberRequestsSyncedThrough).toBeNull();
    expect(afterRun1.jobberRequestsBackfillStartedAt).not.toBeNull();

    graphqlMock.mockReset();
    graphqlMock.mockResolvedValueOnce(page([node(300)], null));
    const run2 = await syncCompanyJobberRequests(await companyRow(co.id));
    expect(run2.complete).toBe(true);
    const done = await companyRow(co.id);
    expect(done.jobberRequestsSyncedThrough).not.toBeNull();
    expect(done.jobberRequestsBackfillStartedAt).toBeNull();
    const rows = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.companyId, co.id));
    expect(rows).toHaveLength(1);
  });
});

describe("upgrade path: an existing watermark stays incremental", () => {
  it("never restarts at the floor and never grows backfill markers", async () => {
    const co = await makeCompany("upgraded");
    // A company synced under the old lookback regime: watermark present.
    const watermark = new Date("2026-08-15T08:00:00.000Z");
    await db
      .update(companiesTable)
      .set({ jobberRequestsSyncedThrough: watermark })
      .where(eq(companiesTable.id, co.id));

    graphqlMock.mockReset();
    graphqlMock.mockResolvedValueOnce(page([], null));
    const result = await syncCompanyJobberRequests(await companyRow(co.id));
    expect(result.complete).toBe(true);

    // Incremental filter — watermark minus overlap, NOT the history floor.
    expect(callVars(0).filter.updatedAt?.after).toBe(
      new Date(watermark.getTime() - OVERLAP_MS).toISOString(),
    );
    expect(callVars(0).after).toBeNull();

    const after = await companyRow(co.id);
    expect(after.jobberRequestsBackfillStartedAt).toBeNull();
    expect(after.jobberRequestsBackfillEndCursor).toBeNull();
    expect(after.jobberRequestsBackfillFilterFloor).toBeNull();
    // Watermark advanced by the complete pull, not rewound to the floor era.
    expect(after.jobberRequestsSyncedThrough!.getTime()).toBeGreaterThan(
      watermark.getTime(),
    );
  });

  it("an incremental capped pull holds the watermark and still writes no backfill cursor", async () => {
    const co = await makeCompany("inc-cap");
    const watermark = new Date("2026-08-15T09:00:00.000Z");
    await db
      .update(companiesTable)
      .set({ jobberRequestsSyncedThrough: watermark })
      .where(eq(companiesTable.id, co.id));

    graphqlMock.mockReset();
    graphqlMock.mockResolvedValue(page([node(500)], "inc_cursor"));
    const result = await syncCompanyJobberRequests(await companyRow(co.id));
    expect(result.complete).toBe(false);
    expect(graphqlMock).toHaveBeenCalledTimes(MAX_PAGES);

    const after = await companyRow(co.id);
    // Watermark held — the overlap window re-reads next run — and the
    // backfill cursor stays reserved for genuine backfills: an incremental
    // cursor would be scoped to a moving updatedAt filter and poison resume.
    expect(after.jobberRequestsSyncedThrough!.getTime()).toBe(
      watermark.getTime(),
    );
    expect(after.jobberRequestsBackfillEndCursor).toBeNull();
    expect(after.jobberRequestsBackfillFilterFloor).toBeNull();
    expect(after.jobberRequestsBackfillStartedAt).toBeNull();
  });
});
