/**
 * Jobber calendar pull tests.
 *
 * The Jobber API itself is stubbed; what's being proved here is the part that
 * can quietly ruin an owner's day — that the import only ever touches rows it
 * created, that a moved address drops its old pin, and that a job disappearing
 * from Jobber cancels rather than deletes.
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

import { db, pool, companiesTable, bookingsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  syncCompanyCalendar,
  formatJobberAddress,
  jobberCustomerName,
  jobberDurationMinutes,
  type JobberCalendarJob,
} from "./jobberCalendarSync";

const runId = `${Date.now()}_${process.pid}`;
let companyId: number;

function jobberJob(over: Partial<JobberCalendarJob> = {}): JobberCalendarJob {
  return {
    id: `job_${runId}_1`,
    title: "Move-out clean",
    startAt: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
    endAt: new Date(
      Date.now() + 3 * 24 * 3600 * 1000 + 2 * 3600 * 1000,
    ).toISOString(),
    client: { firstName: "Dana", lastName: "Reed", phone: "+15550001234" },
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

/** Make the stubbed Jobber account return exactly these jobs, one page. */
function respondWith(jobs: JobberCalendarJob[]): void {
  graphqlMock.mockReset();
  graphqlMock.mockResolvedValue({
    jobs: { nodes: jobs, pageInfo: { hasNextPage: false, endCursor: null } },
  });
}

async function company() {
  const [row] = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId));
  return row!;
}

async function imported(jobberJobId: string) {
  const [row] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.jobberSyncedJobId, jobberJobId));
  return row;
}

beforeAll(async () => {
  const [row] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `jcs_owner_${runId}`,
      name: `Jobber Sync Co ${runId}`,
      timezone: "America/Edmonton",
      jobberConnected: true,
      jobberAccessToken: "enc",
      jobberRefreshToken: "enc",
    })
    .returning();
  companyId = row!.id;
});

afterAll(async () => {
  await db.delete(bookingsTable).where(eq(bookingsTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end();
});

describe("field mapping", () => {
  it("builds a one-line address a geocoder can use", () => {
    expect(formatJobberAddress(jobberJob())).toBe(
      "12 Main St, Calgary, AB T2P 1J9",
    );
  });

  it("returns no address rather than an empty string", () => {
    expect(formatJobberAddress(jobberJob({ property: null }))).toBeNull();
    expect(
      formatJobberAddress(
        jobberJob({
          property: {
            address: {
              street: null,
              city: null,
              province: null,
              postalCode: null,
            },
          },
        }),
      ),
    ).toBeNull();
  });

  it("falls back to the job title when there's no client on the job", () => {
    expect(jobberCustomerName(jobberJob({ client: null }))).toBe(
      "Move-out clean",
    );
    expect(jobberCustomerName(jobberJob({ client: null, title: null }))).toBe(
      "Jobber job",
    );
  });

  it("reads the job length from start and end", () => {
    expect(jobberDurationMinutes(jobberJob())).toBe(120);
    expect(jobberDurationMinutes(jobberJob({ endAt: null }))).toBeNull();
    // An end before the start is nonsense, not a negative duration.
    expect(
      jobberDurationMinutes(
        jobberJob({
          endAt: "2020-01-01T00:00:00Z",
          startAt: "2030-01-01T00:00:00Z",
        }),
      ),
    ).toBeNull();
  });
});

describe("syncCompanyCalendar", () => {
  it("imports a scheduled job, then updates it instead of duplicating", async () => {
    respondWith([jobberJob()]);
    const first = await syncCompanyCalendar(await company());
    expect(first.imported).toBe(1);
    expect(first.updated).toBe(0);

    const booking = await imported(`job_${runId}_1`);
    expect(booking).toBeTruthy();
    expect(booking!.customerName).toBe("Dana Reed");
    expect(booking!.customerAddress).toBe("12 Main St, Calgary, AB T2P 1J9");
    expect(booking!.status).toBe("confirmed");
    expect(booking!.durationMinutes).toBe(120);

    respondWith([jobberJob({ title: "Deep clean" })]);
    const second = await syncCompanyCalendar(await company());
    expect(second.imported).toBe(0);
    expect(second.updated).toBe(1);

    const all = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.jobberSyncedJobId, `job_${runId}_1`));
    expect(all).toHaveLength(1);
    expect(all[0]!.service).toBe("Deep clean");
  });

  it("drops the old pin when the address moves", async () => {
    await db
      .update(bookingsTable)
      .set({ lat: 51.04, lng: -114.07, geocodedAt: new Date() })
      .where(eq(bookingsTable.jobberSyncedJobId, `job_${runId}_1`));

    respondWith([
      jobberJob({
        property: {
          address: {
            street: "99 Elsewhere Ave",
            city: "Calgary",
            province: "AB",
            postalCode: "T2P 1J9",
          },
        },
      }),
    ]);
    await syncCompanyCalendar(await company());

    const booking = await imported(`job_${runId}_1`);
    expect(booking!.customerAddress).toContain("99 Elsewhere Ave");
    // Stale coordinates would send the crew to the previous house.
    expect(booking!.lat).toBeNull();
    expect(booking!.lng).toBeNull();
    expect(booking!.geocodedAt).toBeNull();
  });

  it("skips a job Jobber hasn't scheduled", async () => {
    // The already-imported job rides along, otherwise the cancellation sweep
    // would (correctly) decide it had left Jobber.
    respondWith([
      jobberJob(),
      jobberJob({ id: `job_${runId}_unscheduled`, startAt: null }),
    ]);
    const result = await syncCompanyCalendar(await company());
    expect(result.skipped).toBe(1);
    expect(result.imported).toBe(0);
    expect(await imported(`job_${runId}_unscheduled`)).toBeUndefined();
  });

  it("cancels an imported job that left Jobber, and never a local booking", async () => {
    const [local] = await db
      .insert(bookingsTable)
      .values({
        companyId,
        callId: null,
        customerName: "Booked by phone",
        customerPhone: "+15559998888",
        customerAddress: "3 Local Rd",
        service: "Standard clean",
        scheduledFor: new Date(Date.now() + 2 * 24 * 3600 * 1000),
        status: "confirmed",
      })
      .returning();

    // Jobber now reports no jobs at all in the window.
    respondWith([]);
    const result = await syncCompanyCalendar(await company());
    expect(result.canceled).toBeGreaterThanOrEqual(1);

    expect((await imported(`job_${runId}_1`))!.status).toBe("canceled");
    const [untouched] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, local!.id));
    expect(untouched!.status).toBe("confirmed");

    await db
      .delete(bookingsTable)
      .where(inArray(bookingsTable.id, [local!.id]));
  });

  it("brings a cancelled job back when it reappears in Jobber", async () => {
    respondWith([jobberJob()]);
    await syncCompanyCalendar(await company());
    expect((await imported(`job_${runId}_1`))!.status).toBe("confirmed");
  });

  it("never cancels off a pull that came back incomplete", async () => {
    // The job is imported and healthy going in.
    respondWith([jobberJob()]);
    await syncCompanyCalendar(await company());
    expect((await imported(`job_${runId}_1`))!.status).toBe("confirmed");

    // Now Jobber hands back a first page promising more, then a page with no
    // payload. We've seen none of the real inventory, so "missing from the
    // pull" cannot mean "cancelled in Jobber" — the window spans months and
    // getting this wrong would wipe the calendar.
    graphqlMock.mockReset();
    graphqlMock
      .mockResolvedValueOnce({
        jobs: {
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: "cursor_1" },
        },
      })
      .mockResolvedValueOnce({ jobs: null });

    const result = await syncCompanyCalendar(await company());

    expect(result.canceled).toBe(0);
    expect((await imported(`job_${runId}_1`))!.status).toBe("confirmed");
  });

  it("does nothing when Jobber access needs reconnecting", async () => {
    graphqlMock.mockReset();
    const disconnected = { ...(await company()), jobberNeedsReauth: true };
    const result = await syncCompanyCalendar(disconnected);
    expect(result.imported).toBe(0);
    expect(graphqlMock).not.toHaveBeenCalled();
  });
});
