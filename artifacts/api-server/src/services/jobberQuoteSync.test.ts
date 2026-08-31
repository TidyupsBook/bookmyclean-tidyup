/**
 * Jobber quote pull tests.
 *
 * The Jobber API is stubbed; what's proved here is the mirror's honesty:
 * re-pulls update in place instead of duplicating, money survives the
 * float-dollars → integer-cents crossing, the watermark only asks for what's
 * new, and every quoted customer lands in the client directory.
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
  jobberQuotesTable,
  leadsTable,
  activityTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  syncCompanyJobberQuotes,
  type JobberQuoteNode,
} from "./jobberQuoteSync";

const runId = `${Date.now()}_${process.pid}`;
let companyId: number;

function quote(
  n: number,
  over: Partial<JobberQuoteNode> = {},
): JobberQuoteNode {
  return {
    id: `quote_${runId}_${n}`,
    quoteNumber: 1000 + n,
    title: "Move-out clean",
    quoteStatus: "awaiting_response",
    createdAt: new Date(Date.now() - n * 3600_000).toISOString(),
    updatedAt: new Date(Date.now() - n * 60_000).toISOString(),
    sentAt: new Date(Date.now() - n * 1800_000).toISOString(),
    transitionedAt: null,
    jobberWebUri: `https://secure.getjobber.com/quotes/${n}`,
    amounts: { total: 189.99, subtotal: 180.94 },
    request: null,
    client: {
      id: `client_${runId}_${n}`,
      // Distinct phones per client — the directory (correctly) merges two
      // sightings of one number into one row.
      firstName: "Quinn",
      lastName: `Payne${n}`,
      phone: `+155500098${70 + n}`,
    },
    property: {
      address: {
        street: "12 Main St",
        city: "Calgary",
        province: "AB",
        postalCode: "T2P 1J9",
      },
    },
    ...over,
  };
}

function respondWith(quotes: JobberQuoteNode[]): void {
  graphqlMock.mockReset();
  graphqlMock.mockResolvedValue({
    quotes: {
      nodes: quotes,
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });
}

async function pendingBookingFor(jobberQuoteId: string) {
  const [row] = await db
    .select()
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.companyId, companyId),
        eq(bookingsTable.jobberSyncedQuoteId, jobberQuoteId),
      ),
    );
  return row;
}

async function stored() {
  return db
    .select()
    .from(jobberQuotesTable)
    .where(eq(jobberQuotesTable.companyId, companyId));
}

beforeAll(async () => {
  const [row] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `jqs_owner_${runId}`,
      name: `Quote Sync Co ${runId}`,
      timezone: "America/Edmonton",
      jobberConnected: true,
      jobberAccessToken: "enc",
      jobberRefreshToken: "enc",
    })
    .returning();
  companyId = row!.id;
});

afterAll(async () => {
  await db.delete(activityTable).where(eq(activityTable.companyId, companyId));
  await db.delete(leadsTable).where(eq(leadsTable.companyId, companyId));
  await db.delete(bookingsTable).where(eq(bookingsTable.companyId, companyId));
  await db
    .delete(jobberQuotesTable)
    .where(eq(jobberQuotesTable.companyId, companyId));
  await db.delete(clientsTable).where(eq(clientsTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end();
});

describe("syncCompanyJobberQuotes", () => {
  it("imports quotes with money as integer cents", async () => {
    respondWith([quote(1), quote(2, { quoteStatus: "draft", amounts: null })]);
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    const result = await syncCompanyJobberQuotes(company!);
    expect(result.imported).toBe(2);
    expect(result.complete).toBe(true);

    const all = await stored();
    expect(all).toHaveLength(2);
    const q1 = all.find((q) => q.jobberQuoteId === `quote_${runId}_1`)!;
    expect(q1.totalCents).toBe(18999);
    expect(q1.status).toBe("awaiting_response");
    expect(q1.clientName).toBe("Quinn Payne1");
    expect(q1.propertyAddress).toBe("12 Main St, Calgary, AB T2P 1J9");
    const q2 = all.find((q) => q.jobberQuoteId === `quote_${runId}_2`)!;
    expect(q2.totalCents).toBeNull();
    expect(q2.status).toBe("draft");
  });

  it("puts every quoted customer in the client directory", async () => {
    const clients = await db
      .select()
      .from(clientsTable)
      .where(eq(clientsTable.companyId, companyId));
    const names = clients.map((c) => c.name).sort();
    expect(names).toEqual(["Quinn Payne1", "Quinn Payne2"]);
    expect(clients.every((c) => c.source === "jobber")).toBe(true);
  });

  it("re-pulling a changed quote updates in place, never duplicates", async () => {
    respondWith([quote(1, { quoteStatus: "approved" })]);
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    const result = await syncCompanyJobberQuotes(company!);
    expect(result.updated).toBe(1);
    expect(result.imported).toBe(0);

    const all = await stored();
    expect(all).toHaveLength(2);
    const q1 = all.find((q) => q.jobberQuoteId === `quote_${runId}_1`)!;
    expect(q1.status).toBe("approved");
  });

  it("asks Jobber only for what changed since the watermark", async () => {
    respondWith([]);
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    await syncCompanyJobberQuotes(company!);
    const [, , variables] = graphqlMock.mock.calls[0] as [
      string,
      string,
      { filter: { updatedAt: { after: string } } },
    ];
    const after = new Date(variables.filter.updatedAt.after).getTime();
    // Watermark = the newest stored jobberUpdatedAt minus a small overlap —
    // minutes ago, not the year-long first pull.
    expect(Date.now() - after).toBeLessThan(60 * 60 * 1000);
  });

  it("a capped pull holds the watermark for the next run", async () => {
    const [before] = await db
      .select({ cursor: companiesTable.jobberQuotesSyncedThrough })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    // Complete pulls above must have advanced the cursor.
    expect(before!.cursor).not.toBeNull();

    // Jobber claims there is always another page: the run hits its page cap.
    // The stored rows carry fresh updatedAt values — exactly the trap: pages
    // arrive in CREATED_AT order, so rows already written say nothing about
    // updates on the pages never seen. The cursor must not move.
    graphqlMock.mockReset();
    graphqlMock.mockResolvedValue({
      quotes: {
        nodes: [quote(50)],
        pageInfo: { hasNextPage: true, endCursor: "cap" },
      },
    });
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    const result = await syncCompanyJobberQuotes(company!);
    expect(result.complete).toBe(false);
    expect(graphqlMock).toHaveBeenCalledTimes(40);

    const [after] = await db
      .select({ cursor: companiesTable.jobberQuotesSyncedThrough })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    expect(after!.cursor!.getTime()).toBe(before!.cursor!.getTime());
  });

  it("stays in watermark mode on every subsequent sync and ignores mirrored createdAt", async () => {
    const initialWatermark = new Date("2026-08-01T12:00:00.000Z");
    const misleadingCreatedAt = new Date("2099-01-01T00:00:00.000Z");
    const [watermarkedRow] = await db
      .insert(companiesTable)
      .values({
        ownerUserId: `jqs_watermarked_owner_${runId}`,
        name: `Quote Watermarked Co ${runId}`,
        timezone: "America/Edmonton",
        jobberConnected: true,
        jobberAccessToken: "enc",
        jobberRefreshToken: "enc",
        jobberQuotesSyncedThrough: initialWatermark,
      })
      .returning();
    const watermarkedCompanyId = watermarkedRow!.id;

    try {
      // If watermark mode accidentally consults MAX(jobberCreatedAt), this
      // future-dated row would produce an obviously wrong createdAt filter.
      await db.insert(jobberQuotesTable).values({
        companyId: watermarkedCompanyId,
        jobberQuoteId: `quote_${runId}_misleading_created_at`,
        status: "awaiting_response",
        jobberCreatedAt: misleadingCreatedAt,
        lastSyncedAt: new Date(),
      });

      graphqlMock.mockReset();
      graphqlMock.mockResolvedValue({
        quotes: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });

      const [watermarkedCompany] = await db
        .select()
        .from(companiesTable)
        .where(eq(companiesTable.id, watermarkedCompanyId));

      await syncCompanyJobberQuotes(watermarkedCompany!);
      await syncCompanyJobberQuotes(watermarkedCompany!);

      expect(graphqlMock).toHaveBeenCalledTimes(2);
      for (const [, , variables] of graphqlMock.mock.calls) {
        const filter = (
          variables as {
            filter: {
              createdAt?: { after: string };
              updatedAt?: { after: string };
            };
          }
        ).filter;
        expect(filter.createdAt).toBeUndefined();
        expect(filter.updatedAt).toBeDefined();
        expect(new Date(filter.updatedAt!.after).getTime()).toBeLessThan(
          misleadingCreatedAt.getTime(),
        );
      }
    } finally {
      await db
        .delete(jobberQuotesTable)
        .where(eq(jobberQuotesTable.companyId, watermarkedCompanyId));
      await db
        .delete(companiesTable)
        .where(eq(companiesTable.id, watermarkedCompanyId));
    }
  });

  it("shows an open Jobber-born quote as a pending booking carrying the quote", async () => {
    const b = await pendingBookingFor(`quote_${runId}_1`);
    expect(b).toBeDefined();
    expect(b!.status).toBe("pending");
    expect(b!.customerName).toBe("Quinn Payne1");
    expect(b!.service).toBe("Move-out clean");
    // Subtotal, not the tax-inclusive total — quotedAmount is pre-tax.
    expect(b!.quotedAmount).toBe(180.94);
    // The real Jobber quote id rides along, which is what lets the accept
    // flow schedule from Jobber's own quote — and blocks a duplicate push.
    expect(b!.jobberQuoteId).toBe(`quote_${runId}_1`);
    expect(b!.jobberQuoteWebUri).toBe("https://secure.getjobber.com/quotes/1");
    expect(b!.jobberSynced).toBe(true);
    // Never wearing the calendar-sweep or push id columns.
    expect(b!.jobberJobId).toBeNull();
    expect(b!.jobberVisitId).toBeNull();
    expect(b!.jobberSyncedJobId).toBeNull();
  });

  it("a converted quote cancels a pending booking the office never accepted", async () => {
    respondWith([quote(1, { quoteStatus: "converted" })]);
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    await syncCompanyJobberQuotes(company!);
    const b = await pendingBookingFor(`quote_${runId}_1`);
    expect(b!.status).toBe("canceled");
  });

  it("adopts a quote the app itself pushed instead of importing a copy", async () => {
    const pushedQuoteId = `quote_${runId}_pushed`;
    await db.insert(bookingsTable).values({
      companyId,
      customerName: "Pushed Quote",
      customerPhone: "+15550008888",
      service: "Recurring clean",
      scheduledFor: new Date(),
      status: "pending",
      jobberSynced: true,
      jobberQuoteId: pushedQuoteId,
    });
    respondWith([quote(7, { id: pushedQuoteId })]);
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    await syncCompanyJobberQuotes(company!);

    const rows = await db
      .select()
      .from(bookingsTable)
      .where(
        and(
          eq(bookingsTable.companyId, companyId),
          eq(bookingsTable.jobberQuoteId, pushedQuoteId),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.jobberSyncedQuoteId).toBe(pushedQuoteId);
    expect(rows[0]!.customerName).toBe("Pushed Quote");
  });

  it("a quote raised from an imported request lands on that request's booking", async () => {
    const requestId = `request_${runId}_linked`;
    const [reqBooking] = await db
      .insert(bookingsTable)
      .values({
        companyId,
        customerName: "Rae Quest",
        customerPhone: "+15550007777",
        service: "Deep clean estimate",
        scheduledFor: new Date(),
        status: "pending",
        jobberSynced: true,
        jobberSyncedRequestId: requestId,
      })
      .returning();

    respondWith([quote(8, { request: { id: requestId } })]);
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    await syncCompanyJobberQuotes(company!);

    // One piece of work, one row: no second booking for the quote.
    const all = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.companyId, companyId));
    expect(
      all.filter((b) => b.jobberSyncedQuoteId === `quote_${runId}_8`),
    ).toHaveLength(1);
    const merged = all.find((b) => b.id === reqBooking!.id)!;
    expect(merged.jobberSyncedQuoteId).toBe(`quote_${runId}_8`);
    expect(merged.jobberQuoteId).toBe(`quote_${runId}_8`);
    expect(merged.quotedAmount).toBe(180.94);
  });

  it("a big account reaches later quotes across successive backfill runs", async () => {
    // Proves that a >cap×page-size history doesn't starve: each capped run
    // advances MAX(createdAt) in the mirror, so the next run picks up where
    // the last one left off instead of re-reading page 1 forever.
    const [bigRow] = await db
      .insert(companiesTable)
      .values({
        ownerUserId: `jqs_big_owner_${runId}`,
        name: `Quote Big Co ${runId}`,
        timezone: "America/Edmonton",
        jobberConnected: true,
        jobberAccessToken: "enc",
        jobberRefreshToken: "enc",
      })
      .returning();
    const bigCompanyId = bigRow!.id;

    try {
      // Batch 1: old quotes (createdAt far in the past). This run will hit the
      // page cap and stop — Jobber says there are more pages.
      const oldCreatedAt = new Date(
        Date.now() - 10 * 24 * 3600_000,
      ).toISOString();
      const newCreatedAt = new Date(
        Date.now() - 1 * 24 * 3600_000,
      ).toISOString();

      const batch1Quote = {
        ...quote(200),
        id: `quote_${runId}_big_old`,
        createdAt: oldCreatedAt,
        updatedAt: oldCreatedAt,
      };

      // First run hits MAX_PAGES (40): always returns hasNextPage=true.
      graphqlMock.mockReset();
      graphqlMock.mockResolvedValue({
        quotes: {
          nodes: [batch1Quote],
          pageInfo: { hasNextPage: true, endCursor: "cursor_old" },
        },
      });

      const [bigCompany1] = await db
        .select()
        .from(companiesTable)
        .where(eq(companiesTable.id, bigCompanyId));
      const result1 = await syncCompanyJobberQuotes(bigCompany1!);
      expect(result1.complete).toBe(false);

      // Watermark is still unset — backfill is not done.
      const [afterRun1] = await db
        .select({ cursor: companiesTable.jobberQuotesSyncedThrough })
        .from(companiesTable)
        .where(eq(companiesTable.id, bigCompanyId));
      expect(afterRun1!.cursor).toBeNull();

      // Capture what createdAt filter the FIRST call of run 1 used.
      const [, , run1Vars] = graphqlMock.mock.calls[0] as [
        string,
        string,
        {
          filter: {
            createdAt?: { after: string };
            updatedAt?: { after: string };
          };
        },
      ];
      expect(run1Vars.filter.createdAt).toBeDefined();
      const run1After = run1Vars.filter.createdAt!.after;

      // After the capped run: cursor, filter floor, and backfillStartedAt must
      // all be persisted (checked here, before run 2, which clears them).
      const [afterRun1Full] = await db
        .select({
          backfillEndCursor: companiesTable.jobberQuotesBackfillEndCursor,
          backfillFilterFloor: companiesTable.jobberQuotesBackfillFilterFloor,
          backfillStartedAt: companiesTable.jobberQuotesBackfillStartedAt,
        })
        .from(companiesTable)
        .where(eq(companiesTable.id, bigCompanyId));
      expect(afterRun1Full!.backfillEndCursor).toBe("cursor_old");
      // The filter floor must be saved alongside the cursor so run 2 submits
      // the exact same createdAt query that produced this cursor.
      expect(afterRun1Full!.backfillFilterFloor).not.toBeNull();
      // backfillStartedAt is set on the first backfill run (no prior rows).
      expect(afterRun1Full!.backfillStartedAt).not.toBeNull();

      // Second run: Jobber now returns a "newer" quote and completes.
      const batch2Quote = {
        ...quote(201),
        id: `quote_${runId}_big_new`,
        createdAt: newCreatedAt,
        updatedAt: newCreatedAt,
      };
      graphqlMock.mockReset();
      graphqlMock.mockResolvedValue({
        quotes: {
          nodes: [batch2Quote],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });

      const [bigCompany2] = await db
        .select()
        .from(companiesTable)
        .where(eq(companiesTable.id, bigCompanyId));
      const result2 = await syncCompanyJobberQuotes(bigCompany2!);
      expect(result2.complete).toBe(true);

      // The second run must have resumed from MAX(createdAt) of mirrored rows,
      // which is the oldCreatedAt from run 1 — not from FIRST_PULL_DAYS ago.
      const [, , run2Vars] = graphqlMock.mock.calls[0] as [
        string,
        string,
        {
          filter: {
            createdAt?: { after: string };
            updatedAt?: { after: string };
          };
        },
      ];
      expect(run2Vars.filter.createdAt).toBeDefined();
      const run2After = run2Vars.filter.createdAt!.after;
      // Run 2 must use the exact filter floor that was saved with the cursor —
      // not a freshly recalculated floor — because Jobber cursors are
      // query-scoped and only valid for the filter that produced them.
      expect(run2After).toBe(afterRun1Full!.backfillFilterFloor);
      // The cursor chain started from run 1's floor; run 1After is captured so
      // it can be referenced in this block, confirming the variable is in scope.
      void run1After;

      // Both quotes are in the mirror: the backfill eventually reached them all.
      const mirrored = await db
        .select({ jobberQuoteId: jobberQuotesTable.jobberQuoteId })
        .from(jobberQuotesTable)
        .where(eq(jobberQuotesTable.companyId, bigCompanyId));
      const ids = mirrored.map((r) => r.jobberQuoteId);
      expect(ids).toContain(`quote_${runId}_big_old`);
      expect(ids).toContain(`quote_${runId}_big_new`);

      // Watermark is now set (backfill completed) and all three markers cleared.
      const [afterRun2] = await db
        .select({
          cursor: companiesTable.jobberQuotesSyncedThrough,
          backfillStartedAt: companiesTable.jobberQuotesBackfillStartedAt,
          backfillEndCursor: companiesTable.jobberQuotesBackfillEndCursor,
          backfillFilterFloor: companiesTable.jobberQuotesBackfillFilterFloor,
        })
        .from(companiesTable)
        .where(eq(companiesTable.id, bigCompanyId));
      expect(afterRun2!.cursor).not.toBeNull();
      expect(afterRun2!.backfillStartedAt).toBeNull();
      expect(afterRun2!.backfillEndCursor).toBeNull();
      expect(afterRun2!.backfillFilterFloor).toBeNull();
    } finally {
      await db
        .delete(jobberQuotesTable)
        .where(eq(jobberQuotesTable.companyId, bigCompanyId));
      await db
        .delete(bookingsTable)
        .where(eq(bookingsTable.companyId, bigCompanyId));
      await db
        .delete(clientsTable)
        .where(eq(clientsTable.companyId, bigCompanyId));
      await db
        .delete(companiesTable)
        .where(eq(companiesTable.id, bigCompanyId));
    }
  });

  it("records backfillStartedAt even when mirrored rows already exist but watermark is unset", async () => {
    // Primary rollout scenario: an account whose prior capped syncs wrote rows
    // but never completed — the existing code left these accounts with rows in
    // jobber_quotes but no watermark. The fix must set backfillStartedAt on
    // the resumed run (floor !== null) so the completing run anchors the
    // watermark to the start of this resumed backfill, not just the last run.
    const [resumeRow] = await db
      .insert(companiesTable)
      .values({
        ownerUserId: `jqs_resume_owner_${runId}`,
        name: `Quote Resume Co ${runId}`,
        timezone: "America/Edmonton",
        jobberConnected: true,
        jobberAccessToken: "enc",
        jobberRefreshToken: "enc",
      })
      .returning();
    const resumeCompanyId = resumeRow!.id;

    try {
      // Pre-seed a mirrored row as if a prior capped run already imported it.
      const oldCreatedAt = new Date(Date.now() - 10 * 24 * 3600_000);
      await db.insert(jobberQuotesTable).values({
        companyId: resumeCompanyId,
        jobberQuoteId: `quote_${runId}_resume_old`,
        status: "awaiting_response",
        jobberCreatedAt: oldCreatedAt,
        lastSyncedAt: new Date(),
      });

      // No watermark on the company row — state left by prior capped syncs.
      const [beforeSync] = await db
        .select({
          cursor: companiesTable.jobberQuotesSyncedThrough,
          backfillStartedAt: companiesTable.jobberQuotesBackfillStartedAt,
        })
        .from(companiesTable)
        .where(eq(companiesTable.id, resumeCompanyId));
      expect(beforeSync!.cursor).toBeNull();
      expect(beforeSync!.backfillStartedAt).toBeNull();

      // Run the sync: Jobber returns one more quote and completes.
      graphqlMock.mockReset();
      graphqlMock.mockResolvedValue({
        quotes: {
          nodes: [
            {
              ...quote(400),
              id: `quote_${runId}_resume_new`,
              createdAt: new Date(Date.now() - 1 * 24 * 3600_000).toISOString(),
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
      const [resumeCompany] = await db
        .select()
        .from(companiesTable)
        .where(eq(companiesTable.id, resumeCompanyId));
      const before = Date.now();
      await syncCompanyJobberQuotes(resumeCompany!);

      // backfillStartedAt must be set — this is what anchors the watermark.
      const [afterSync] = await db
        .select({
          cursor: companiesTable.jobberQuotesSyncedThrough,
          backfillStartedAt: companiesTable.jobberQuotesBackfillStartedAt,
        })
        .from(companiesTable)
        .where(eq(companiesTable.id, resumeCompanyId));
      // The run completed, so the watermark is now set and the marker cleared.
      expect(afterSync!.cursor).not.toBeNull();
      expect(afterSync!.backfillStartedAt).toBeNull();
      // Watermark must reach back to cover the backfill start, not just the
      // last ten minutes — it should be at or before the sync started.
      expect(afterSync!.cursor!.getTime()).toBeLessThanOrEqual(before);
    } finally {
      await db
        .delete(jobberQuotesTable)
        .where(eq(jobberQuotesTable.companyId, resumeCompanyId));
      await db
        .delete(bookingsTable)
        .where(eq(bookingsTable.companyId, resumeCompanyId));
      await db
        .delete(clientsTable)
        .where(eq(clientsTable.companyId, resumeCompanyId));
      await db
        .delete(companiesTable)
        .where(eq(companiesTable.id, resumeCompanyId));
    }
  });

  it("re-reads quotes at the capped-run boundary when createdAt values tie", async () => {
    // Jobber's createdAt resolution is one second. If the page cap falls
    // among quotes sharing the same timestamp, a strict `after=MAX` would
    // exclude every remaining quote at that timestamp on the next run. The
    // sync steps back by one second (BACKFILL_CURSOR_OVERLAP_MS) so that
    // group is re-read; the upsert absorbs the already-mirrored ones.
    const [tieRow] = await db
      .insert(companiesTable)
      .values({
        ownerUserId: `jqs_tie_owner_${runId}`,
        name: `Quote Tie Co ${runId}`,
        timezone: "America/Edmonton",
        jobberConnected: true,
        jobberAccessToken: "enc",
        jobberRefreshToken: "enc",
      })
      .returning();
    const tieCompanyId = tieRow!.id;

    try {
      // All three quotes share the same createdAt second.
      const sharedTs = new Date(
        Math.floor(Date.now() / 1000) * 1000 - 5 * 24 * 3600_000,
      ).toISOString();
      const makeNode = (n: number) => ({
        ...quote(n),
        id: `quote_${runId}_tie_${n}`,
        createdAt: sharedTs,
        updatedAt: sharedTs,
      });

      // Run 1: page cap — Jobber only delivers quote A, claims more exist.
      graphqlMock.mockReset();
      graphqlMock.mockResolvedValue({
        quotes: {
          nodes: [makeNode(300)],
          pageInfo: { hasNextPage: true, endCursor: "cursor_tie" },
        },
      });
      const [tc1] = await db
        .select()
        .from(companiesTable)
        .where(eq(companiesTable.id, tieCompanyId));
      await syncCompanyJobberQuotes(tc1!);

      // After run 1: cursor and filter floor must both be persisted together
      // (checked before run 2, because run 2's completion clears them).
      const [afterTieRun1] = await db
        .select({
          backfillEndCursor: companiesTable.jobberQuotesBackfillEndCursor,
          backfillFilterFloor: companiesTable.jobberQuotesBackfillFilterFloor,
        })
        .from(companiesTable)
        .where(eq(companiesTable.id, tieCompanyId));
      expect(afterTieRun1!.backfillEndCursor).toBe("cursor_tie");
      // Filter floor must be saved alongside the cursor.
      expect(afterTieRun1!.backfillFilterFloor).not.toBeNull();

      // Run 2: completes, delivering quote B and C (same timestamp as A).
      graphqlMock.mockReset();
      graphqlMock.mockResolvedValue({
        quotes: {
          nodes: [makeNode(301), makeNode(302)],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
      const [tc2] = await db
        .select()
        .from(companiesTable)
        .where(eq(companiesTable.id, tieCompanyId));
      await syncCompanyJobberQuotes(tc2!);

      // Run 2 must have started from *before* MAX(createdAt) so quotes B & C
      // were not excluded by a strict-after boundary, AND must have used the
      // saved Jobber cursor so it resumes mid-page rather than page 1.
      const [, , run2Vars] = graphqlMock.mock.calls[0] as [
        string,
        string,
        {
          filter: { createdAt?: { after: string } };
          after?: string | null;
        },
      ];
      expect(run2Vars.filter.createdAt).toBeDefined();
      // Run 2 must use the exact saved filter floor — not a recalculated one —
      // so the query-scoped cursor from run 1 is valid on run 2's request.
      expect(run2Vars.filter.createdAt!.after).toBe(
        afterTieRun1!.backfillFilterFloor,
      );
      // That floor must be strictly earlier than the shared timestamp so
      // Jobber returns quotes at that timestamp on run 2.
      expect(new Date(run2Vars.filter.createdAt!.after).getTime()).toBeLessThan(
        new Date(sharedTs).getTime(),
      );
      // The saved cursor is passed as the initial 'after' pagination param.
      expect(run2Vars.after).toBe("cursor_tie");

      // All three markers cleared after completion.
      const [afterTieRun2] = await db
        .select({
          backfillEndCursor: companiesTable.jobberQuotesBackfillEndCursor,
          backfillFilterFloor: companiesTable.jobberQuotesBackfillFilterFloor,
          backfillStartedAt: companiesTable.jobberQuotesBackfillStartedAt,
        })
        .from(companiesTable)
        .where(eq(companiesTable.id, tieCompanyId));
      expect(afterTieRun2!.backfillEndCursor).toBeNull();
      expect(afterTieRun2!.backfillFilterFloor).toBeNull();
      expect(afterTieRun2!.backfillStartedAt).toBeNull();

      // All three quotes land in the mirror.
      const mirrored = await db
        .select({ jobberQuoteId: jobberQuotesTable.jobberQuoteId })
        .from(jobberQuotesTable)
        .where(eq(jobberQuotesTable.companyId, tieCompanyId));
      const ids = mirrored.map((r) => r.jobberQuoteId);
      expect(ids).toContain(`quote_${runId}_tie_300`);
      expect(ids).toContain(`quote_${runId}_tie_301`);
      expect(ids).toContain(`quote_${runId}_tie_302`);
    } finally {
      await db
        .delete(jobberQuotesTable)
        .where(eq(jobberQuotesTable.companyId, tieCompanyId));
      await db
        .delete(bookingsTable)
        .where(eq(bookingsTable.companyId, tieCompanyId));
      await db
        .delete(clientsTable)
        .where(eq(clientsTable.companyId, tieCompanyId));
      await db
        .delete(companiesTable)
        .where(eq(companiesTable.id, tieCompanyId));
    }
  });

  it("does not save the end cursor or filter floor when node processing fails", async () => {
    // If any node write throws, the cursor+floor pair must NOT be persisted.
    // Saving them before the writes would let the next run skip to a point past
    // pages whose quotes were never actually committed to the mirror.
    const [faultRow] = await db
      .insert(companiesTable)
      .values({
        ownerUserId: `jqs_fault_owner_${runId}`,
        name: `Quote Fault Co ${runId}`,
        timezone: "America/Edmonton",
        jobberConnected: true,
        jobberAccessToken: "enc",
        jobberRefreshToken: "enc",
      })
      .returning();
    const faultCompanyId = faultRow!.id;

    try {
      // Capped run so capEndCursor would be set if things went well.
      graphqlMock.mockReset();
      graphqlMock.mockResolvedValue({
        quotes: {
          nodes: [quote(500)],
          pageInfo: { hasNextPage: true, endCursor: "cursor_fault" },
        },
      });

      // Spy on db.insert: throw the first time it is called (which will be the
      // INSERT into jobber_quotes during node processing).
      const origInsert = db.insert.bind(db);
      const insertSpy = vi
        .spyOn(db, "insert")
        .mockImplementationOnce((...args) => {
          void args;
          throw new Error("db fault injected");
        });

      const [faultCompany] = await db
        .select()
        .from(companiesTable)
        .where(eq(companiesTable.id, faultCompanyId));
      try {
        await expect(syncCompanyJobberQuotes(faultCompany!)).rejects.toThrow(
          "db fault injected",
        );
      } finally {
        insertSpy.mockRestore();
        void origInsert; // keep reference live so no lint warning
      }

      // Cursor and filter floor must be null — node processing failed, so
      // progress must not be recorded.
      const [afterFault] = await db
        .select({
          backfillEndCursor: companiesTable.jobberQuotesBackfillEndCursor,
          backfillFilterFloor: companiesTable.jobberQuotesBackfillFilterFloor,
        })
        .from(companiesTable)
        .where(eq(companiesTable.id, faultCompanyId));
      expect(afterFault!.backfillEndCursor).toBeNull();
      expect(afterFault!.backfillFilterFloor).toBeNull();
    } finally {
      await db
        .delete(jobberQuotesTable)
        .where(eq(jobberQuotesTable.companyId, faultCompanyId));
      await db
        .delete(bookingsTable)
        .where(eq(bookingsTable.companyId, faultCompanyId));
      await db
        .delete(clientsTable)
        .where(eq(clientsTable.companyId, faultCompanyId));
      await db
        .delete(companiesTable)
        .where(eq(companiesTable.id, faultCompanyId));
    }
  });

  it("uses createdAt filter during backfill (no watermark yet)", async () => {
    // A brand-new company has no watermark: the first pull must filter on
    // createdAt (matching the CREATED_AT sort) so successive capped runs can
    // resume from MAX(mirrored createdAt) rather than re-reading page 1 forever.
    const [freshRow] = await db
      .insert(companiesTable)
      .values({
        ownerUserId: `jqs_backfill_owner_${runId}`,
        name: `Quote Backfill Co ${runId}`,
        timezone: "America/Edmonton",
        jobberConnected: true,
        jobberAccessToken: "enc",
        jobberRefreshToken: "enc",
      })
      .returning();
    const freshCompanyId = freshRow!.id;

    try {
      respondWith([quote(90)]);
      const [freshCompany] = await db
        .select()
        .from(companiesTable)
        .where(eq(companiesTable.id, freshCompanyId));
      await syncCompanyJobberQuotes(freshCompany!);

      const [, , variables] = graphqlMock.mock.calls[0] as [
        string,
        string,
        {
          filter: {
            createdAt?: { after: string };
            updatedAt?: { after: string };
          };
        },
      ];
      expect(variables.filter.createdAt).toBeDefined();
      expect(variables.filter.updatedAt).toBeUndefined();
    } finally {
      await db
        .delete(jobberQuotesTable)
        .where(eq(jobberQuotesTable.companyId, freshCompanyId));
      await db
        .delete(bookingsTable)
        .where(eq(bookingsTable.companyId, freshCompanyId));
      await db
        .delete(clientsTable)
        .where(eq(clientsTable.companyId, freshCompanyId));
      await db
        .delete(companiesTable)
        .where(eq(companiesTable.id, freshCompanyId));
    }
  });

  it("does nothing for a company that isn't connected", async () => {
    graphqlMock.mockReset();
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    const result = await syncCompanyJobberQuotes({
      ...company!,
      jobberConnected: false,
    });
    expect(result.imported + result.updated).toBe(0);
    expect(graphqlMock).not.toHaveBeenCalled();
  });
});

describe("a Jobber quote claiming its lead", () => {
  /** A lead the Jobber request import created, still sitting "new". */
  async function makeLead(n: number, over: Record<string, unknown> = {}) {
    const [row] = await db
      .insert(leadsTable)
      .values({
        companyId,
        source: "jobber",
        externalId: `lead_ext_${runId}_${n}`,
        sourceTab: "Jobber requests",
        firstName: "Lena",
        lastName: `Quoted${n}`,
        phoneNumber: `+1 (555) 000-${1200 + n}`,
        jobberRequestId: `request_${runId}_${n}`,
        jobberClientId: `client_${runId}_${n}`,
        jobberWebUri: `https://secure.getjobber.com/requests/${n}`,
        status: "new",
        ...over,
      })
      .returning();
    return row!;
  }

  async function reloadLead(id: number) {
    const [row] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, id));
    return row!;
  }

  async function convertedAnnouncements(bookingId: number) {
    const rows = await db
      .select()
      .from(activityTable)
      .where(
        and(
          eq(activityTable.companyId, companyId),
          eq(activityTable.type, "lead_converted"),
          eq(activityTable.bookingId, bookingId),
        ),
      );
    return rows.length;
  }

  async function sync() {
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    await syncCompanyJobberQuotes(company!);
  }

  it("converts the lead whose request the imported quote answers — exactly once", async () => {
    const lead = await makeLead(60);
    respondWith([quote(60, { request: { id: `request_${runId}_60` } })]);
    await sync();

    // The import made a pending booking for the quote, and the lead is no
    // longer sitting "new" beside it.
    const booking = await pendingBookingFor(`quote_${runId}_60`);
    expect(booking).toBeDefined();
    const after = await reloadLead(lead.id);
    expect(after.status).toBe("converted");
    expect(after.convertedBookingId).toBe(booking!.id);
    // The booking points back at its lead, same as the manual convert.
    expect(booking!.leadId).toBe(lead.id);
    expect(await convertedAnnouncements(booking!.id)).toBe(1);

    // A replayed pull refreshes the booking but must not convert — or
    // announce — a second time.
    respondWith([quote(60, { request: { id: `request_${runId}_60` } })]);
    await sync();
    const replayed = await reloadLead(lead.id);
    expect(replayed.status).toBe("converted");
    expect(replayed.convertedBookingId).toBe(booking!.id);
    expect(await convertedAnnouncements(booking!.id)).toBe(1);
  });

  it("never resurrects a dismissed lead", async () => {
    const lead = await makeLead(61, { status: "dismissed" });
    respondWith([quote(61, { request: { id: `request_${runId}_61` } })]);
    await sync();

    // The booking imports either way — the quote is real work — but the
    // dismissed lead stays exactly where the office put it.
    expect(await pendingBookingFor(`quote_${runId}_61`)).toBeDefined();
    const after = await reloadLead(lead.id);
    expect(after.status).toBe("dismissed");
    expect(after.convertedBookingId).toBeNull();
  });

  it("leaves an already-converted lead pointing at its original booking", async () => {
    const [manual] = await db
      .insert(bookingsTable)
      .values({
        companyId,
        customerName: "Manually Converted",
        customerPhone: "+15550001262",
        service: "Deep clean",
        scheduledFor: new Date(),
        status: "pending",
      })
      .returning();
    const lead = await makeLead(62, {
      status: "converted",
      convertedBookingId: manual!.id,
    });
    respondWith([quote(62, { request: { id: `request_${runId}_62` } })]);
    await sync();

    const after = await reloadLead(lead.id);
    expect(after.status).toBe("converted");
    expect(after.convertedBookingId).toBe(manual!.id);
  });

  it("converts the lead when the quote lands on the request's existing booking", async () => {
    // The request pull already made a booking for this request; the lead
    // row arrived later (webhook ordering) and is still new.
    const [existing] = await db
      .insert(bookingsTable)
      .values({
        companyId,
        customerName: "Riley Requested",
        customerPhone: "+15550001263",
        service: "Move-out clean",
        scheduledFor: new Date(),
        status: "pending",
        jobberSynced: true,
        jobberSyncedRequestId: `request_${runId}_63`,
      })
      .returning();
    const lead = await makeLead(63);
    respondWith([quote(63, { request: { id: `request_${runId}_63` } })]);
    await sync();

    // The quote merged onto the request's booking — and the lead followed it.
    const after = await reloadLead(lead.id);
    expect(after.status).toBe("converted");
    expect(after.convertedBookingId).toBe(existing!.id);
    expect(await convertedAnnouncements(existing!.id)).toBe(1);
  });
});
