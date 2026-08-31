/**
 * One-time Jobber history catch-up tests.
 *
 * What's being proved:
 *  - The pinned floor (Aug 1, 2026) is what the request and quote first
 *    pulls reach back to — not a drifting "N days ago".
 *  - A company whose rolling window still covers the floor is marked done
 *    without spending a single Jobber call.
 *  - A company with a real gap fills it in resumable slices: cleaners land
 *    attached (the slice reuses the calendar pipeline), the cursor only
 *    advances on a complete pull, and once done it never runs again.
 *  - Catch-up slices are IMPORT-ONLY: a synced booking absent from a slice's
 *    pull is never swept to canceled — absence from history means "not
 *    imported yet", not "canceled in Jobber".
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
  bookingAssignmentsTable,
  teamMembersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { runJobberHistoryCatchup } from "./jobberHistoryCatchup";
import { syncCompanyJobberRequests } from "./jobberRequestSync";
import { syncCompanyJobberQuotes } from "./jobberQuoteSync";
import {
  JOBBER_HISTORY_FLOOR,
  JOBBER_HISTORY_FLOOR_DATE,
} from "../lib/jobberHistory";

const runId = `${Date.now()}_${process.pid}`;
const companyIds: number[] = [];

/** The caller's rolling pull this cycle was complete and fully persisted. */
const CERTIFIED = { rollingPullComplete: true };

async function makeCompany(n: number) {
  const [row] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `jhc_owner_${runId}_${n}`,
      name: `History Co ${runId} ${n}`,
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

/** One complete (single-page) visits response. */
function visitsPage(visits: unknown[]): void {
  graphqlMock.mockResolvedValue({
    visits: {
      nodes: visits,
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });
}

function historyVisit(n: number, startAtIso: string, assigneeName?: string) {
  return {
    id: `hvisit_${runId}_${n}`,
    title: "Recurring clean",
    startAt: startAtIso,
    endAt: new Date(Date.parse(startAtIso) + 2 * 3600 * 1000).toISOString(),
    completedAt: startAtIso,
    assignedUsers: {
      nodes: assigneeName
        ? [{ id: `user_${assigneeName}`, name: { full: assigneeName } }]
        : [],
    },
    job: {
      id: `hjob_${runId}_${n}`,
      client: {
        id: `hclient_${runId}_${n}`,
        firstName: "Old",
        lastName: `Client ${n}`,
        phone: "+15550009876",
      },
      property: {
        address: {
          street: `${n} History Ave`,
          city: "Calgary",
          province: "AB",
          postalCode: "T2P 1J9",
        },
      },
    },
  };
}

beforeAll(() => {
  // Only Date is faked — the pg driver's real timers must keep working.
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  graphqlMock.mockReset();
});

afterAll(async () => {
  vi.useRealTimers();
  for (const id of companyIds) {
    await db.delete(bookingsTable).where(eq(bookingsTable.companyId, id));
    await db.delete(teamMembersTable).where(eq(teamMembersTable.companyId, id));
    await db.delete(companiesTable).where(eq(companiesTable.id, id));
  }
  await pool.end();
});

describe("pinned first-pull floors", () => {
  it("request first pull filters from the Aug 2026 floor, not a lookback", async () => {
    vi.setSystemTime(new Date("2026-08-16T18:00:00Z"));
    const company = await makeCompany(1);
    graphqlMock.mockResolvedValue({
      requests: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    await syncCompanyJobberRequests(company);
    const vars = graphqlMock.mock.calls[0]![2] as {
      filter: { updatedAt: { after: string } };
    };
    expect(vars.filter.updatedAt.after).toBe(
      JOBBER_HISTORY_FLOOR.toISOString(),
    );
  });

  it("quote first pull (fresh backfill) filters from the Aug 2026 floor", async () => {
    vi.setSystemTime(new Date("2026-08-16T18:00:00Z"));
    const company = await makeCompany(2);
    graphqlMock.mockResolvedValue({
      quotes: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    await syncCompanyJobberQuotes(company);
    const vars = graphqlMock.mock.calls[0]![2] as {
      filter: { createdAt: { after: string } };
    };
    expect(vars.filter.createdAt.after).toBe(
      JOBBER_HISTORY_FLOOR.toISOString(),
    );
  });
});

describe("calendar history catch-up", () => {
  it("marks a company done without any Jobber call while the window still covers the floor", async () => {
    // Aug 16, 2026: the 90-day back edge (mid-May) is before the floor.
    vi.setSystemTime(new Date("2026-08-16T18:00:00Z"));
    const company = await makeCompany(3);

    const result = await runJobberHistoryCatchup(company, CERTIFIED);

    expect(result.done).toBe(true);
    expect(result.ranSlice).toBe(false);
    expect(graphqlMock).not.toHaveBeenCalled();
    const row = await companyRow(company.id);
    expect(row.jobberHistoryBackfilledAt).not.toBeNull();
  });

  it("refuses the forever done-stamp off an uncertified rolling pull", async () => {
    // Same no-gap situation — but this cycle's rolling pull was skipped or
    // incomplete, so nothing has actually proven the window's contents. The
    // stamp must wait for a certified cycle.
    vi.setSystemTime(new Date("2026-08-16T18:00:00Z"));
    const company = await makeCompany(6);

    const result = await runJobberHistoryCatchup(company, {
      rollingPullComplete: false,
    });

    expect(result.done).toBe(false);
    expect(result.ranSlice).toBe(false);
    expect(graphqlMock).not.toHaveBeenCalled();
    let row = await companyRow(company.id);
    expect(row.jobberHistoryBackfilledAt).toBeNull();

    // The next certified cycle finishes the job.
    const retry = await runJobberHistoryCatchup(company, CERTIFIED);
    expect(retry.done).toBe(true);
    row = await companyRow(company.id);
    expect(row.jobberHistoryBackfilledAt).not.toBeNull();
  });

  it("fills a real gap in slices: crew attached, no sweep, resume, then done forever", async () => {
    // March 1, 2027: the back edge is Dec 1, 2026 — four months past the
    // floor, so there is a real Aug→Dec gap to fill.
    vi.setSystemTime(new Date("2027-03-01T19:00:00Z"));
    const company = await makeCompany(4);
    const [cleaner] = await db
      .insert(teamMembersTable)
      .values({
        companyId: company.id,
        name: "Sergine",
        role: "cleaner",
        active: true,
      })
      .returning();

    // A booking imported by an earlier (rolling) sync, sitting INSIDE the
    // first slice's window but absent from the slice's pull. Import-only
    // means it must stay confirmed.
    const [preexisting] = await db
      .insert(bookingsTable)
      .values({
        companyId: company.id,
        customerName: "Kept Customer",
        customerPhone: "+15550001111",
        service: "Standard clean",
        scheduledFor: new Date("2026-08-05T16:00:00Z"),
        status: "confirmed",
        jobberVisitId: `kept_visit_${runId}`,
        jobberSyncedJobId: `kept_job_${runId}`,
      })
      .returning();

    // Slice 1 (Aug 1 → Aug 31): one historical visit with a known cleaner.
    visitsPage([historyVisit(1, "2026-08-10T16:00:00Z", "Sergine")]);
    const first = await runJobberHistoryCatchup(company, CERTIFIED);

    expect(first.ranSlice).toBe(true);
    expect(first.done).toBe(false);
    expect(first.imported).toBe(1);
    let row = await companyRow(company.id);
    expect(row.jobberHistorySyncedTo).toBe("2026-08-31");
    expect(row.jobberHistoryBackfilledAt).toBeNull();

    // The historical job arrived with its cleaner already attached.
    const [imported] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.jobberVisitId, `hvisit_${runId}_1`));
    expect(imported).toBeDefined();
    const crew = await db
      .select({ teamMemberId: bookingAssignmentsTable.teamMemberId })
      .from(bookingAssignmentsTable)
      .where(eq(bookingAssignmentsTable.bookingId, imported!.id));
    expect(crew.map((c) => c.teamMemberId)).toEqual([cleaner!.id]);

    // Import-only: the absent-from-pull booking was NOT swept to canceled.
    const [kept] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, preexisting!.id));
    expect(kept!.status).toBe("confirmed");

    // Remaining slices (empty months) run one per invocation until the
    // back edge, then the done marker stops everything.
    graphqlMock.mockReset();
    visitsPage([]);
    let done = false;
    for (let i = 0; i < 5 && !done; i++) {
      done = (await runJobberHistoryCatchup(company, CERTIFIED)).done;
    }
    expect(done).toBe(true);
    row = await companyRow(company.id);
    expect(row.jobberHistorySyncedTo).toBe("2026-12-01");
    expect(row.jobberHistoryBackfilledAt).not.toBeNull();

    graphqlMock.mockReset();
    const after = await runJobberHistoryCatchup(company, CERTIFIED);
    expect(after.done).toBe(true);
    expect(after.ranSlice).toBe(false);
    expect(graphqlMock).not.toHaveBeenCalled();
  });

  it("does not advance the cursor when a slice pull is incomplete", async () => {
    vi.setSystemTime(new Date("2027-03-01T19:00:00Z"));
    const company = await makeCompany(5);

    // A malformed page: the sync stops without claiming completeness.
    graphqlMock.mockResolvedValue({});
    const result = await runJobberHistoryCatchup(company, CERTIFIED);

    expect(result.ranSlice).toBe(true);
    expect(result.done).toBe(false);
    const row = await companyRow(company.id);
    expect(row.jobberHistorySyncedTo).toBeNull();
    expect(row.jobberHistoryBackfilledAt).toBeNull();
  });

  it("keeps the floor constant and its date form in lockstep", () => {
    expect(JOBBER_HISTORY_FLOOR.toISOString()).toBe(
      `${JOBBER_HISTORY_FLOOR_DATE}T00:00:00.000Z`,
    );
  });
});
