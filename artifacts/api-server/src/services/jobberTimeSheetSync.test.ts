/**
 * Pulling Jobber's own timers into this app's hours.
 *
 * The Jobber API is stubbed. What matters here is what could put a wrong
 * number on a customer's invoice: a stretch imported twice, a ticking timer
 * counted before it stopped, or an hour that came from Jobber being posted
 * straight back to Jobber as a note.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
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
  bookingTimeEntriesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  importableEntries,
  syncCompanyTimeSheets,
  type JobberJobTimeSheets,
} from "./jobberTimeSheetSync";

const runId = `${Date.now()}_${process.pid}`;
const JOB_ID = `jts_job_${runId}`;
let companyId: number;
let bookingId: number;

const start = new Date(Date.now() - 4 * 3600 * 1000);
const end = new Date(Date.now() - 1 * 3600 * 1000);

function entry(over: Record<string, unknown> = {}) {
  return {
    id: `jts_entry_${runId}_1`,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    ticking: false,
    user: { name: { full: "Cindy Guay" } },
    ...over,
  };
}

/** One page of jobs, each with its clocked stretches, all on one page. */
function respondWith(jobs: JobberJobTimeSheets[]): void {
  graphqlMock.mockReset();
  graphqlMock.mockResolvedValue({
    jobs: {
      nodes: jobs.map((job) => ({
        ...job,
        timeSheetEntries: {
          nodes: job.timeSheetEntries?.nodes ?? [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      })),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });
}

async function company() {
  const [row] = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId));
  return row!;
}

async function storedEntries() {
  return db
    .select()
    .from(bookingTimeEntriesTable)
    .where(eq(bookingTimeEntriesTable.companyId, companyId))
    .orderBy(bookingTimeEntriesTable.startedAt);
}

beforeAll(async () => {
  const [co] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `jts_owner_${runId}`,
      name: `Jobber Timer Co ${runId}`,
      timezone: "America/Edmonton",
      jobberConnected: true,
      jobberAccessToken: "enc",
      jobberRefreshToken: "enc",
    })
    .returning();
  companyId = co!.id;

  const [booking] = await db
    .insert(bookingsTable)
    .values({
      companyId,
      customerName: "Dana Reed",
      customerPhone: "+15550001234",
      service: "Move-out clean",
      scheduledFor: start,
      status: "confirmed",
      jobberSyncedJobId: JOB_ID,
      jobberSynced: true,
    })
    .returning();
  bookingId = booking!.id;
});

beforeEach(async () => {
  await db
    .delete(bookingTimeEntriesTable)
    .where(eq(bookingTimeEntriesTable.companyId, companyId));
});

afterAll(async () => {
  await db
    .delete(bookingTimeEntriesTable)
    .where(eq(bookingTimeEntriesTable.companyId, companyId));
  await db.delete(bookingsTable).where(eq(bookingsTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end();
});

describe("importableEntries", () => {
  it("keeps a finished stretch and the name of who clocked it", () => {
    const got = importableEntries({
      id: JOB_ID,
      timeSheetEntries: { nodes: [entry()] },
    });
    expect(got).toHaveLength(1);
    expect(got[0]!.startedByName).toBe("Cindy Guay");
    expect(got[0]!.endedAt.getTime()).toBe(end.getTime());
  });

  it("ignores a timer still running in Jobber", () => {
    expect(
      importableEntries({
        id: JOB_ID,
        timeSheetEntries: { nodes: [entry({ ticking: true, endAt: null })] },
      }),
    ).toEqual([]);
  });

  it("drops nonsense rather than inventing hours", () => {
    const nodes = [
      entry({ id: "a", endAt: null }),
      entry({ id: "b", startAt: null }),
      entry({
        id: "c",
        startAt: end.toISOString(),
        endAt: start.toISOString(),
      }),
      entry({ id: "d", startAt: "not a date" }),
    ];
    expect(
      importableEntries({ id: JOB_ID, timeSheetEntries: { nodes } }),
    ).toEqual([]);
  });
});

describe("syncCompanyTimeSheets", () => {
  it("records a Jobber timer against the booking, once", async () => {
    respondWith([{ id: JOB_ID, timeSheetEntries: { nodes: [entry()] } }]);

    const first = await syncCompanyTimeSheets(await company());
    expect(first.imported).toBe(1);

    const second = await syncCompanyTimeSheets(await company());
    expect(second.imported).toBe(0);
    expect(second.updated).toBe(0);

    const rows = await storedEntries();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bookingId).toBe(bookingId);
    expect(rows[0]!.startedByName).toBe("Cindy Guay");
    expect(rows[0]!.jobberTimeEntryId).toBe(`jts_entry_${runId}_1`);
    // Never marked as posted back — it came from there.
    expect(rows[0]!.jobberNoteId).toBeNull();
  });

  it("follows a correction made in Jobber", async () => {
    respondWith([{ id: JOB_ID, timeSheetEntries: { nodes: [entry()] } }]);
    await syncCompanyTimeSheets(await company());

    const fixedEnd = new Date(end.getTime() + 30 * 60 * 1000);
    respondWith([
      {
        id: JOB_ID,
        timeSheetEntries: {
          nodes: [entry({ endAt: fixedEnd.toISOString() })],
        },
      },
    ]);
    const result = await syncCompanyTimeSheets(await company());
    expect(result.updated).toBe(1);

    const rows = await storedEntries();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.endedAt!.getTime()).toBe(fixedEnd.getTime());
  });

  it("leaves a job we never imported alone", async () => {
    respondWith([
      { id: `${JOB_ID}_unknown`, timeSheetEntries: { nodes: [entry()] } },
    ]);
    const result = await syncCompanyTimeSheets(await company());
    expect(result.imported).toBe(0);
    expect(await storedEntries()).toHaveLength(0);
  });

  it("does not touch a clock still running in this app", async () => {
    const [open] = await db
      .insert(bookingTimeEntriesTable)
      .values({
        companyId,
        bookingId,
        startedByName: "Maria",
        startedAt: new Date(),
      })
      .returning();

    respondWith([{ id: JOB_ID, timeSheetEntries: { nodes: [entry()] } }]);
    await syncCompanyTimeSheets(await company());

    const [stillOpen] = await db
      .select()
      .from(bookingTimeEntriesTable)
      .where(
        and(
          eq(bookingTimeEntriesTable.id, open!.id),
          eq(bookingTimeEntriesTable.companyId, companyId),
        ),
      );
    expect(stillOpen!.endedAt).toBeNull();
    expect(await storedEntries()).toHaveLength(2);
  });

  it("pages past the first batch of stretches on a busy job", async () => {
    const first = entry({ id: `jts_entry_${runId}_p1` });
    const second = entry({
      id: `jts_entry_${runId}_p2`,
      startAt: new Date(start.getTime() - 5 * 3600 * 1000).toISOString(),
      endAt: new Date(start.getTime() - 4 * 3600 * 1000).toISOString(),
    });

    graphqlMock.mockReset();
    // First response: the job list, with more stretches waiting behind a cursor.
    graphqlMock.mockResolvedValueOnce({
      jobs: {
        nodes: [
          {
            id: JOB_ID,
            timeSheetEntries: {
              nodes: [first],
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    // Second: the follow-up read for that one job.
    graphqlMock.mockResolvedValueOnce({
      job: {
        id: JOB_ID,
        timeSheetEntries: {
          nodes: [second],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });

    const result = await syncCompanyTimeSheets(await company());
    expect(result.imported).toBe(2);
    expect(await storedEntries()).toHaveLength(2);
  });

  it("counts nothing when a racing sync already recorded the stretch", async () => {
    // The row exists but this run doesn't know it: exactly what a manual sync
    // and the poller overlapping looks like.
    await db.insert(bookingTimeEntriesTable).values({
      companyId,
      bookingId,
      startedAt: start,
      endedAt: end,
      jobberTimeEntryId: `jts_entry_${runId}_1`,
    });

    respondWith([{ id: JOB_ID, timeSheetEntries: { nodes: [entry()] } }]);
    const result = await syncCompanyTimeSheets(await company());
    expect(result.imported).toBe(0);
    expect(await storedEntries()).toHaveLength(1);
  });

  it("leaves times the office corrected by hand alone", async () => {
    respondWith([{ id: JOB_ID, timeSheetEntries: { nodes: [entry()] } }]);
    await syncCompanyTimeSheets(await company());

    const corrected = new Date(end.getTime() - 45 * 60 * 1000);
    await db
      .update(bookingTimeEntriesTable)
      .set({ endedAt: corrected, editedAt: new Date() })
      .where(eq(bookingTimeEntriesTable.companyId, companyId));

    respondWith([
      {
        id: JOB_ID,
        timeSheetEntries: {
          nodes: [
            entry({ endAt: new Date(end.getTime() + 3600000).toISOString() }),
          ],
        },
      },
    ]);
    const result = await syncCompanyTimeSheets(await company());
    expect(result.updated).toBe(0);

    const rows = await storedEntries();
    expect(rows[0]!.endedAt!.getTime()).toBe(corrected.getTime());
  });

  it("asks Jobber for nothing when the account is disconnected", async () => {
    respondWith([]);
    const co = await company();
    const result = await syncCompanyTimeSheets({
      ...co,
      jobberConnected: false,
    });
    expect(result).toEqual({ imported: 0, updated: 0 });
    expect(graphqlMock).not.toHaveBeenCalled();
  });
});
