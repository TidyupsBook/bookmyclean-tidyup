/**
 * Approving a quote in the app, and scheduling it into Jobber.
 *
 * Jobber is stubbed at the HTTP boundary, not at our own helpers, so these
 * tests see the exact GraphQL that would go over the wire — the same reason
 * the outbound push tests are written that way.
 *
 * What's proved here is what the owner is trusting:
 *
 *   - the approval is a local fact that Jobber can never undo, and recording
 *     it twice records it once;
 *   - a scheduled job goes over at the booking's *wall-clock* time in the
 *     company's zone, for its expected length;
 *   - a cleaner Jobber doesn't know is reported by name, never quietly
 *     dropped or matched to the wrong somebody;
 *   - the calendar pull adopts the job we scheduled instead of importing it
 *     as a second booking — the highest-risk part of the whole feature;
 *   - moving the booking here moves the Jobber visit, and a visit that can't
 *     be moved leaves the failure on the booking rather than pretending.
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

// Only the token is faked; the real query builders run and their HTTP calls
// are answered by the stub below.
vi.mock("../lib/jobber", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/jobber")>("../lib/jobber");
  return { ...actual, getValidAccessToken: vi.fn(async () => "test-token") };
});

import {
  db,
  pool,
  companiesTable,
  bookingsTable,
  bookingAssignmentsTable,
  teamMembersTable,
  activityTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  approveBooking,
  resolveCrewToJobberUsers,
  scheduleBlockedReason,
  syncScheduledVisit,
  zonedStamp,
} from "./jobberSchedule";
import { syncCompanyCalendar } from "./jobberCalendarSync";

type GraphqlCall = { query: string; variables: Record<string, unknown> };

const calls: GraphqlCall[] = [];
let respond: (call: GraphqlCall) => Promise<unknown> = async () => {
  throw new Error("no responder set");
};

vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
  const call = JSON.parse(init.body) as GraphqlCall;
  calls.push(call);
  const data = await respond(call);
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

const runId = `${Date.now()}_${process.pid}`;
let companyId: number;
/**
 * Each test gets its own Jobber job and visit ids. They are what the
 * duplicate-import guard keys on, so sharing them between tests would let one
 * test's booking adopt another's visit and quietly prove nothing.
 */
let seq = 0;
const jobId = () => `job_${runId}_${seq}`;
const visitId = () => `visit_${runId}_${seq}`;
/** A per-test quote id for imported-quote bookings (unique constraint on synced_quote_id). */
const syncedQuoteId = () => `quo_imported_${runId}_${seq}`;
/** Whether Jobber has, by now, a job made from this test's quote. */
let jobberHasJob = false;
/** Roster ids by name. */
const roster: Record<string, number> = {};

/** Jobber knows Nadia; it has never heard of Rowan. */
const JOBBER_USERS = [
  { id: "usr_nadia", name: { full: "Nadia Okonkwo" } },
  { id: "usr_sam", name: { full: "Sam Vance" } },
];

/** Everything the scheduling path asks for, all succeeding. */
function happyJobber(
  over: {
    visitInJob?: string | null;
    failSchedule?: string;
    failVisitMove?: string;
    visits?: unknown[];
  } = {},
) {
  return async ({ query }: GraphqlCall): Promise<unknown> => {
    if (query.includes("JobberUsers")) {
      return { users: { nodes: JOBBER_USERS } };
    }
    if (query.includes("QuoteExistingJob")) {
      // Jobber only knows about a job once one has been created from the
      // quote — which is exactly the state a lost write leaves behind.
      return {
        quote: {
          jobs: {
            nodes: jobberHasJob
              ? [
                  {
                    id: jobId(),
                    jobberWebUri: "https://jobber/job_1",
                    visits: { nodes: [{ id: visitId() }] },
                  },
                ]
              : [],
          },
        },
      };
    }
    if (query.includes("ScheduleJobFromQuote")) {
      jobberHasJob = true;
      if (over.failSchedule) {
        return {
          jobCreateFromQuote: {
            job: null,
            userErrors: [{ message: over.failSchedule, path: [] }],
          },
        };
      }
      return {
        jobCreateFromQuote: {
          job: {
            id: jobId(),
            jobberWebUri: "https://jobber/job_1",
            visits: {
              nodes:
                over.visitInJob === null
                  ? []
                  : [{ id: over.visitInJob ?? visitId() }],
            },
          },
          userErrors: [],
        },
      };
    }
    if (query.includes("JobFirstVisit")) {
      return { job: { visits: { nodes: [{ id: visitId() }] } } };
    }
    if (query.includes("MoveVisit")) {
      if (over.failVisitMove) {
        return {
          visitEditSchedule: {
            userErrors: [{ message: over.failVisitMove, path: [] }],
          },
        };
      }
      return { visitEditSchedule: { userErrors: [] } };
    }
    if (query.includes("ReassignVisit")) {
      return { visitEditAssignedUsers: { userErrors: [] } };
    }
    if (query.includes("SyncCalendarVisits")) {
      return {
        visits: {
          nodes: over.visits ?? [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    }
    throw new Error(`unstubbed query: ${query}`);
  };
}

async function company() {
  const [row] = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId));
  return row!;
}

async function makeBooking(over: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(bookingsTable)
    .values({
      companyId,
      customerName: "Dee Dee Lawson",
      customerPhone: "(780) 555-0134",
      customerAddress: "12 Maple Crescent",
      addressCity: "Edmonton",
      service: "Deep clean",
      // 10:00 in Edmonton on a summer Thursday — deliberately a different
      // date in UTC's afternoon so a timezone slip is visible.
      scheduledFor: new Date("2026-08-20T16:00:00Z"),
      durationMinutes: 180,
      status: "pending",
      jobberQuoteId: "quo_1",
      ...over,
    })
    .returning();
  return row!;
}

async function makeApprovedBooking(over: Record<string, unknown> = {}) {
  return makeBooking({
    status: "confirmed",
    clientApprovedAt: new Date("2026-08-20T15:00:00Z"),
    clientApprovedBy: "Pat Owner",
    ...over,
  });
}

async function reload(id: number) {
  const [row] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.id, id));
  return row!;
}

async function assign(bookingId: number, names: string[]) {
  await db.insert(bookingAssignmentsTable).values(
    names.map((name) => ({
      bookingId,
      teamMemberId: roster[name]!,
    })),
  );
}

function varsFor(name: string): Record<string, unknown> | undefined {
  return calls.find((c) => c.query.includes(name))?.variables;
}

function countFor(name: string): number {
  return calls.filter((c) => c.query.includes(name)).length;
}

async function activityFor(bookingId: number) {
  return db
    .select()
    .from(activityTable)
    .where(eq(activityTable.bookingId, bookingId));
}

beforeAll(async () => {
  const [row] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `jsched_owner_${runId}`,
      name: `Jobber Schedule Co ${runId}`,
      timezone: "America/Edmonton",
      jobberConnected: true,
      jobberAccessToken: "enc",
      jobberRefreshToken: "enc",
    })
    .returning();
  companyId = row!.id;

  for (const name of ["Nadia Okonkwo", "Rowan Idris"]) {
    const [member] = await db
      .insert(teamMembersTable)
      .values({ companyId, name, role: "cleaner", active: true })
      .returning();
    roster[name] = member!.id;
  }
});

afterAll(async () => {
  await db.delete(activityTable).where(eq(activityTable.companyId, companyId));
  await db.delete(bookingsTable).where(eq(bookingsTable.companyId, companyId));
  await db
    .delete(teamMembersTable)
    .where(eq(teamMembersTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end();
});

beforeEach(() => {
  calls.length = 0;
  seq += 1;
  jobberHasJob = false;
  respond = happyJobber();
});

describe("recording that the client said yes", () => {
  it("confirms the booking and names who recorded it without calling Jobber", async () => {
    const booking = await makeBooking();
    const result = await approveBooking(await company(), booking, {
      schedule: false,
      recordedBy: "Pat Owner",
    });

    expect(result.recorded).toBe(true);
    expect(result.scheduledInJobber).toBe(false);
    expect(result.jobberError).toBeNull();

    const row = await reload(booking.id);
    expect(row.status).toBe("confirmed");
    expect(row.clientApprovedAt).not.toBeNull();
    expect(row.clientApprovedBy).toBe("Pat Owner");
    // Approval is local-only: Jobber has no supported quoteApprove mutation.
    expect(calls).toHaveLength(0);
    expect(countFor("ScheduleJobFromQuote")).toBe(0);

    const feed = await activityFor(booking.id);
    expect(feed).toHaveLength(1);
    expect(feed[0]!.message).toContain("Pat Owner");
  });

  it("is idempotent — a second click records one approval and one feed line", async () => {
    const booking = await makeBooking();
    const co = await company();
    await approveBooking(co, booking, {
      schedule: false,
      recordedBy: "Pat Owner",
    });
    const again = await approveBooking(co, await reload(booking.id), {
      schedule: false,
      recordedBy: "Someone Else",
    });

    expect(again.recorded).toBe(false);
    const row = await reload(booking.id);
    expect(row.clientApprovedBy).toBe("Pat Owner");
    expect(await activityFor(booking.id)).toHaveLength(1);
  });

  it("records approval without noticing that Jobber is unreachable", async () => {
    const booking = await makeBooking();
    respond = async () => {
      throw new Error("Jobber is down");
    };

    const result = await approveBooking(await company(), booking, {
      schedule: false,
      recordedBy: "Pat Owner",
    });

    expect(result.recorded).toBe(true);
    expect(result.jobberError).toBeNull();
    expect(calls).toHaveLength(0);

    const row = await reload(booking.id);
    // Approval is local, so an unrelated Jobber outage is not an error.
    expect(row.status).toBe("confirmed");
    expect(row.clientApprovedAt).not.toBeNull();
    expect(row.jobberSyncError).toBeNull();
  });

  it("leaves a completed booking completed rather than dragging it back", async () => {
    const booking = await makeBooking({ status: "completed" });
    await approveBooking(await company(), booking, {
      schedule: false,
      recordedBy: "Pat Owner",
    });

    const row = await reload(booking.id);
    expect(row.status).toBe("completed");
    expect(row.clientApprovedAt).not.toBeNull();
  });

  it("refuses to schedule a booking with no Jobber quote, in words the office can act on", async () => {
    const booking = await makeBooking({ jobberQuoteId: null });
    expect(scheduleBlockedReason(await company(), booking)).toContain(
      "no Jobber quote yet",
    );
  });
});

describe("scheduling the approved quote into Jobber", () => {
  it("sends the booking's own wall-clock window and stores what came back", async () => {
    const booking = await makeApprovedBooking();
    const result = await approveBooking(await company(), booking, {
      schedule: true,
      recordedBy: "Pat Owner",
    });

    expect(result.scheduledInJobber).toBe(true);
    expect(result.jobberError).toBeNull();

    const input = varsFor("ScheduleJobFromQuote")?.["input"] as {
      scheduling: Record<string, unknown>;
      timeframe?: Record<string, unknown>;
    };
    // 16:00Z is 10:00 in Edmonton, and the booking is three hours long. If
    // this ever reads 16:00 the crew is being sent out six hours late.
    expect(input.scheduling["startTime"]).toBe("10:00:00");
    expect(input.scheduling["endTime"]).toBe("13:00:00");
    expect(input.timeframe?.["startAt"]).toBe("2026-08-20");
    expect(input.scheduling["createVisits"]).toBe(true);

    const row = await reload(booking.id);
    expect(row.jobberCreatedJobId).toBe(jobId());
    expect(row.jobberCreatedVisitId).toBe(visitId());
    expect(row.jobberJobWebUri).toBe("https://jobber/job_1");
    // The ids Jobber's own importer keys on stay empty: this job came from
    // us, and "imported from Jobber" must keep meaning what it did.
    expect(row.jobberSyncedJobId).toBeNull();
    expect(row.jobberVisitId).toBeNull();
  });

  it("attaches the crew it can match and reports the cleaner it can't", async () => {
    const booking = await makeApprovedBooking();
    await assign(booking.id, ["Nadia Okonkwo", "Rowan Idris"]);

    const result = await approveBooking(await company(), booking, {
      schedule: true,
      recordedBy: "Pat Owner",
    });

    expect(result.scheduledInJobber).toBe(true);
    expect(result.unmatchedCrew).toEqual(["Rowan Idris"]);

    const input = varsFor("ScheduleJobFromQuote")?.["input"] as {
      scheduling: Record<string, unknown>;
    };
    expect(input.scheduling["assignedTo"]).toEqual(["usr_nadia"]);

    // The owner hears about it in the feed too, not only in the toast.
    const feed = await activityFor(booking.id);
    expect(feed.some((a) => a.message.includes("Rowan Idris"))).toBe(true);
  });

  it("asks the job for its visit when the create didn't hand one back", async () => {
    respond = happyJobber({ visitInJob: null });
    const booking = await makeApprovedBooking();
    await approveBooking(await company(), booking, {
      schedule: true,
      recordedBy: "Pat Owner",
    });

    expect(countFor("JobFirstVisit")).toBe(1);
    expect((await reload(booking.id)).jobberCreatedVisitId).toBe(visitId());
  });

  it("never schedules the same booking twice", async () => {
    const booking = await makeApprovedBooking();
    const co = await company();
    await approveBooking(co, booking, {
      schedule: true,
      recordedBy: "Pat Owner",
    });
    const again = await approveBooking(co, await reload(booking.id), {
      schedule: true,
      recordedBy: "Pat Owner",
    });

    expect(again.scheduledInJobber).toBe(true);
    expect(countFor("ScheduleJobFromQuote")).toBe(1);
  });

  it("adopts the job Jobber already made when our record of it was lost", async () => {
    const booking = await makeApprovedBooking();
    const co = await company();
    await approveBooking(co, booking, {
      schedule: true,
      recordedBy: "Pat Owner",
    });

    // What a crashed process or a lost write leaves behind: Jobber has the
    // job, we have no idea it exists.
    await db
      .update(bookingsTable)
      .set({
        jobberCreatedJobId: null,
        jobberCreatedVisitId: null,
        jobberJobWebUri: null,
      })
      .where(eq(bookingsTable.id, booking.id));
    calls.length = 0;

    const retry = await approveBooking(co, await reload(booking.id), {
      schedule: true,
      recordedBy: "Pat Owner",
    });

    expect(retry.scheduledInJobber).toBe(true);
    // The whole point: no second job on the customer's calendar.
    expect(countFor("ScheduleJobFromQuote")).toBe(0);
    const row = await reload(booking.id);
    expect(row.jobberCreatedJobId).toBe(jobId());
    expect(row.jobberCreatedVisitId).toBe(visitId());
  });

  it("keeps the job id even if the booking's claim is taken mid-call", async () => {
    const booking = await makeApprovedBooking();
    const co = await company();

    // Steal the claim while Jobber is answering — the case where the id
    // would otherwise be thrown away and re-created on the next click.
    respond = async (call) => {
      const answer = await happyJobber()(call);
      if (call.query.includes("ScheduleJobFromQuote")) {
        await db
          .update(bookingsTable)
          .set({ jobberCreatedJobId: null })
          .where(eq(bookingsTable.id, booking.id));
      }
      return answer;
    };

    const result = await approveBooking(co, booking, {
      schedule: true,
      recordedBy: "Pat Owner",
    });

    expect(result.scheduledInJobber).toBe(true);
    expect((await reload(booking.id)).jobberCreatedJobId).toBe(jobId());
  });

  it("releases its claim when Jobber refuses, so the office can retry", async () => {
    respond = happyJobber({ failSchedule: "Quote is not approved" });
    const booking = await makeApprovedBooking();

    const result = await approveBooking(await company(), booking, {
      schedule: true,
      recordedBy: "Pat Owner",
    });

    expect(result.scheduledInJobber).toBe(false);
    expect(result.jobberError).toContain("Quote is not approved");
    const row = await reload(booking.id);
    // Approval stands, no half-written job id, and the failure is visible.
    expect(row.clientApprovedAt).not.toBeNull();
    expect(row.jobberCreatedJobId).toBeNull();
    expect(row.jobberSyncError).toBeTruthy();
  });

  it("schedules from an imported quote's id and never creates a second booking", async () => {
    // An imported-quote booking carries both jobberSyncedQuoteId (set by the
    // quote pull) and jobberQuoteId (the same value — what the accept flow
    // schedules from). The key distinction from a pushed booking is that
    // jobberSyncedQuoteId is populated, marking the row as Jobber-originated.
    const qid = syncedQuoteId();
    const booking = await makeBooking({
      jobberSyncedQuoteId: qid,
      jobberQuoteId: qid,
    });

    const result = await approveBooking(await company(), booking, {
      schedule: true,
      recordedBy: "Pat Owner",
      approvalObservedInJobber: true,
    });

    expect(result.recorded).toBe(false);
    expect(result.scheduledInJobber).toBe(true);
    expect(result.jobberError).toBeNull();

    // ScheduleJobFromQuote must reference the imported id — not a newly minted
    // one — so Jobber converts the quote that already exists on the client's
    // record rather than creating a second one alongside it.
    expect(countFor("ScheduleJobFromQuote")).toBe(1);
    expect(varsFor("ScheduleJobFromQuote")?.["quoteId"]).toBe(qid);

    const row = await reload(booking.id);
    expect(row.status).toBe("confirmed");
    expect(row.clientApprovedAt).toBeNull();
    expect(row.jobberCreatedJobId).toBe(jobId());
    expect(row.jobberCreatedVisitId).toBe(visitId());
    // The inbound sync id must stay so the quote pull continues to recognise
    // the row as imported and never inserts a duplicate pending booking.
    expect(row.jobberSyncedQuoteId).toBe(qid);
  });
});

describe("the calendar pull meeting a job we scheduled", () => {
  it("adopts an imported-quote booking instead of creating a duplicate", async () => {
    // A booking the quote pull created: jobberSyncedQuoteId marks it as
    // Jobber-originated; jobberQuoteId is the same value and is what the
    // accept flow schedules from.
    const qid = syncedQuoteId();
    const booking = await makeBooking({
      jobberSyncedQuoteId: qid,
      jobberQuoteId: qid,
    });
    await approveBooking(await company(), booking, {
      schedule: true,
      recordedBy: "Pat Owner",
      approvalObservedInJobber: true,
    });

    const before = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.companyId, companyId));

    respond = happyJobber({
      visits: [
        {
          id: visitId(),
          title: "Deep clean",
          startAt: new Date("2026-08-20T16:00:00Z").toISOString(),
          endAt: new Date("2026-08-20T19:00:00Z").toISOString(),
          completedAt: null,
          assignedUsers: { nodes: [] },
          job: {
            id: jobId(),
            client: {
              id: "jcl_1",
              firstName: "Dee Dee",
              lastName: "Lawson",
              phone: null,
            },
            property: {
              address: {
                street: "12 Maple Crescent",
                city: "Edmonton",
                province: "AB",
                postalCode: "T5J 0N3",
              },
            },
          },
        },
      ],
    });
    await syncCompanyCalendar(await company(), null, {
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    });

    const after = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.companyId, companyId));
    // No second row — the pull adopted the imported-quote booking.
    expect(after).toHaveLength(before.length);

    const row = await reload(booking.id);
    // Adoption stamps the inbound sync ids so future pulls find it normally.
    expect(row.jobberVisitId).toBe(visitId());
    expect(row.jobberSyncedJobId).toBe(jobId());
    expect(row.jobberSynced).toBe(true);
    // The imported-quote marker must survive — the quote pull uses it to
    // recognise this row and must never insert a second pending booking.
    expect(row.jobberSyncedQuoteId).toBe(qid);
    // Adoption must not erase what the office captured on the call.
    expect(row.customerPhone).toBe("(780) 555-0134");
  });

  it("updates our own booking instead of importing a second one", async () => {
    const booking = await makeApprovedBooking();
    await approveBooking(await company(), booking, {
      schedule: true,
      recordedBy: "Pat Owner",
    });

    const before = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.companyId, companyId));

    // Jobber now reports the visit we just created, as the hourly pull would.
    respond = happyJobber({
      visits: [
        {
          id: visitId(),
          title: "Deep clean",
          startAt: new Date("2026-08-20T16:00:00Z").toISOString(),
          endAt: new Date("2026-08-20T19:00:00Z").toISOString(),
          completedAt: null,
          assignedUsers: { nodes: [] },
          job: {
            id: jobId(),
            // Jobber has no phone for this client, which is the case that
            // used to blank the number the office took down on the call.
            client: { firstName: "Dee Dee", lastName: "Lawson", phone: null },
            property: {
              address: {
                street: "12 Maple Crescent",
                city: "Edmonton",
                province: "AB",
                postalCode: "T5J 0N3",
              },
            },
          },
        },
      ],
    });
    await syncCompanyCalendar(await company(), null, {
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    });

    const after = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.companyId, companyId));
    expect(after).toHaveLength(before.length);

    const row = await reload(booking.id);
    // The pull adopted our row: it now carries the sync ids as well, so the
    // next pull finds it the ordinary way.
    expect(row.jobberVisitId).toBe(visitId());
    expect(row.jobberSyncedJobId).toBe(jobId());
    expect(row.jobberSynced).toBe(true);
    // Adoption must not throw away what the office typed in.
    expect(row.customerPhone).toBe("(780) 555-0134");
  });
});

describe("keeping the Jobber visit in step", () => {
  it("moves the visit when the booking is rescheduled here", async () => {
    const booking = await makeApprovedBooking();
    await approveBooking(await company(), booking, {
      schedule: true,
      recordedBy: "Pat Owner",
    });

    await db
      .update(bookingsTable)
      .set({ scheduledFor: new Date("2026-08-21T20:00:00Z") })
      .where(eq(bookingsTable.id, booking.id));
    calls.length = 0;

    const result = await syncScheduledVisit(
      await company(),
      await reload(booking.id),
      { time: true },
    );

    expect(result.status).toBe("updated");
    const input = varsFor("MoveVisit")?.["input"] as {
      startAt: Record<string, string>;
      endAt: Record<string, string>;
    };
    expect(input.startAt).toEqual({
      date: "2026-08-21",
      time: "14:00:00",
      timezone: "America/Edmonton",
    });
    expect(input.endAt.time).toBe("17:00:00");
  });

  it("reassigns the visit when the crew changes here", async () => {
    const booking = await makeApprovedBooking();
    await approveBooking(await company(), booking, {
      schedule: true,
      recordedBy: "Pat Owner",
    });
    await assign(booking.id, ["Nadia Okonkwo"]);
    calls.length = 0;

    const result = await syncScheduledVisit(
      await company(),
      await reload(booking.id),
      { crew: true },
    );

    expect(result.status).toBe("updated");
    expect(varsFor("ReassignVisit")?.["input"]).toEqual({
      assignedUserIds: ["usr_nadia"],
    });
  });

  it("leaves a booking that never went to Jobber alone", async () => {
    const booking = await makeBooking();
    const result = await syncScheduledVisit(await company(), booking, {
      time: true,
    });

    expect(result.status).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("records the failure on the booking when the visit can't be moved", async () => {
    const booking = await makeApprovedBooking();
    await approveBooking(await company(), booking, {
      schedule: true,
      recordedBy: "Pat Owner",
    });
    respond = happyJobber({ failVisitMove: "Visit is locked" });

    const result = await syncScheduledVisit(
      await company(),
      await reload(booking.id),
      { time: true },
    );

    expect(result.status).toBe("failed");
    const row = await reload(booking.id);
    expect(row.jobberSyncError).toContain("Visit is locked");
  });
});

describe("wall-clock conversion", () => {
  it("reads an instant in the company's own zone, not the server's", () => {
    expect(
      zonedStamp(new Date("2026-08-20T16:00:00Z"), "America/Edmonton"),
    ).toEqual({ date: "2026-08-20", time: "10:00:00" });
    // Across midnight in the other direction, where a UTC-based answer would
    // land the crew on the wrong day entirely.
    expect(
      zonedStamp(new Date("2026-08-21T04:30:00Z"), "America/Edmonton"),
    ).toEqual({ date: "2026-08-20", time: "22:30:00" });
  });
});

describe("picking Jobber users for a crew", () => {
  const users = [
    { id: "u_nadia", name: "Nadia Okonkwo" },
    { id: "u_sam", name: "Sam Vance" },
  ];

  it("a linked cleaner goes out by their link, whatever they're called now", () => {
    const r = resolveCrewToJobberUsers(
      [{ id: 1, name: "Totally Renamed", jobberUserId: "u_sam" }],
      users,
      new Set(["u_sam"]),
    );
    expect(r.userIds).toEqual(["u_sam"]);
    expect(r.unmatched).toEqual([]);
  });

  it("a linked cleaner whose Jobber user is gone is reported, never re-guessed", () => {
    // Jobber has an exact-name lookalike — the link still refuses to guess.
    const r = resolveCrewToJobberUsers(
      [{ id: 1, name: "Nadia Okonkwo", jobberUserId: "u_deactivated" }],
      users,
      new Set(["u_deactivated"]),
    );
    expect(r.userIds).toEqual([]);
    expect(r.unmatched).toEqual(["Nadia Okonkwo"]);
  });

  it("an unlinked cleaner still matches by name without creating a link", () => {
    const r = resolveCrewToJobberUsers(
      [{ id: 7, name: "Nadia O", jobberUserId: null }],
      users,
      new Set(),
    );
    expect(r.userIds).toEqual(["u_nadia"]);
    expect(r.unmatched).toEqual([]);
  });

  it("a Jobber user linked to someone else is off the name-match table", () => {
    // Another seat owns u_nadia; this same-named cleaner may not take it.
    const r = resolveCrewToJobberUsers(
      [{ id: 7, name: "Nadia Okonkwo", jobberUserId: null }],
      users,
      new Set(["u_nadia"]),
    );
    expect(r.userIds).toEqual([]);
    expect(r.unmatched).toEqual(["Nadia Okonkwo"]);
  });

  it("two seats claiming the same Jobber user both stay unmatched", () => {
    // "Sam Vance" (exact) and "Sam V" (first name) both land on u_sam. The
    // The name told us nothing about which of them he is: assigning both would
    // send one person two people's jobs, so neither goes out.
    const r = resolveCrewToJobberUsers(
      [
        { id: 1, name: "Sam Vance", jobberUserId: null },
        { id: 2, name: "Sam V", jobberUserId: null },
      ],
      users,
      new Set(),
    );
    expect(r.userIds).toEqual([]);
    expect([...r.unmatched].sort()).toEqual(["Sam V", "Sam Vance"]);
  });
});
