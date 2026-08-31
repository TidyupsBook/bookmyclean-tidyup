/**
 * Recording that a client said yes, and putting the job on Jobber's calendar.
 *
 * Most customers approve a quote on the phone, not by tapping the link they
 * were texted. Before this, the office had nowhere to record that and no way
 * to turn it into a scheduled job without re-typing everything in Jobber.
 *
 * Three rules shape what follows:
 *
 *   - The local approval is the fact. Jobber has no supported quote-approval
 *     mutation, so recording a yes never calls Jobber and never depends on the
 *     integration being online.
 *   - A job we schedule is claimed before Jobber is called and recorded only
 *     if the claim survived, the same pattern the outbound push uses — two
 *     dispatchers clicking must not put two jobs on the calendar.
 *   - The ids of a job we created live in their own columns. The inbound
 *     calendar pull adopts those rows rather than importing them a second
 *     time, and "this came from Jobber" keeps meaning what it always did.
 */
import { and, eq, isNotNull, isNull, like, or } from "drizzle-orm";
import {
  db,
  bookingsTable,
  bookingAssignmentsTable,
  teamMembersTable,
  activityTable,
  type Booking,
  type Company,
} from "@workspace/db";
import {
  getValidAccessToken,
  listJobberUsers,
  createJobberJobFromQuote,
  fetchJobberJobForQuote,
  fetchJobberFirstVisitId,
  type JobberScheduledJob,
  editJobberVisitSchedule,
  editJobberVisitAssignedUsers,
} from "../lib/jobber";
import {
  matchAssigneesToRoster,
  type RosterMember,
} from "./jobberCalendarSync";
import {
  clearNonContactJobberFailure,
  nonContactJobberSuccessFields,
  recordJobberFailure,
  runQueuedForCompany,
  REAUTH_REASON,
} from "./jobberPush";
import { logger } from "../lib/logger";
import { customerLabel } from "../lib/bookingFormat";

/** A claim marker in `jobber_created_job_id`, never a real Jobber id. */
const SCHEDULE_CLAIM_PREFIX = "pending:";
const SCHEDULE_CLAIM_STALE_MS = 5 * 60 * 1000;

/** What the schedule falls back to when nobody set an expected length. */
const DEFAULT_DURATION_MINUTES = 120;

export function isScheduleClaim(value: string | null): boolean {
  return Boolean(value?.startsWith(SCHEDULE_CLAIM_PREFIX));
}

/** The Jobber job this booking really has, once it isn't a claim marker. */
export function scheduledJobberJobId(booking: Booking): string | null {
  return booking.jobberCreatedJobId &&
    !isScheduleClaim(booking.jobberCreatedJobId)
    ? booking.jobberCreatedJobId
    : null;
}

function realQuoteId(booking: Booking): string | null {
  return booking.jobberQuoteId && !booking.jobberQuoteId.startsWith("pending:")
    ? booking.jobberQuoteId
    : null;
}

/**
 * Why this booking can't be approved-and-scheduled, in words the office can
 * act on. Separate from doing it, so a menu can grey the action out with a
 * reason instead of failing after the click.
 */
export function scheduleBlockedReason(
  company: Company,
  booking: Booking,
): string | null {
  if (!realQuoteId(booking)) {
    return "This booking has no Jobber quote yet — sync it to Jobber first.";
  }
  if (company.jobberNeedsReauth) return REAUTH_REASON;
  if (!company.jobberConnected || !company.jobberRefreshToken) {
    return "Connect Jobber before scheduling jobs";
  }
  return null;
}

/* ─────────────────────── wall-clock in company time ─────────────────────── */

type ZonedStamp = { date: string; time: string };

/**
 * The date and time-of-day an instant falls on in the company's own zone.
 *
 * Jobber is told the wall-clock time, never UTC: the crew, the customer and
 * the dispatcher all agreed on "Thursday at 10", and a job that lands at 4am
 * because the server sits in another zone is worse than no job at all.
 */
export function zonedStamp(when: Date, timeZone: string): ZonedStamp {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(when);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // Midnight comes back as "24" from some ICU builds; the day is already the
  // right one, so only the hour needs correcting.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${hour}:${get("minute")}:${get("second")}`,
  };
}

function bookingDurationMinutes(booking: Booking): number {
  const minutes = booking.durationMinutes ?? DEFAULT_DURATION_MINUTES;
  return minutes > 0 ? minutes : DEFAULT_DURATION_MINUTES;
}

function bookingWindow(
  company: Company,
  booking: Booking,
): { start: ZonedStamp; end: ZonedStamp } {
  const endsAt = new Date(
    booking.scheduledFor.getTime() + bookingDurationMinutes(booking) * 60_000,
  );
  return {
    start: zonedStamp(booking.scheduledFor, company.timezone),
    end: zonedStamp(endsAt, company.timezone),
  };
}

/* ──────────────────────────── crew matching ──────────────────────────── */

/** A booking's cleaner as the outbound matcher sees them. */
export type OutboundCrewMember = {
  id: number;
  name: string;
  jobberUserId: string | null;
};

/**
 * Which Jobber users this booking's cleaners are.
 *
 * A stored link decides first — a linked cleaner goes out under exactly the
 * Jobber user the owner said they are, whatever either side calls them
 * today. A linked cleaner whose Jobber user is gone (deactivated there) is
 * reported by name rather than silently re-guessed: the link said who they
 * ARE, and a name lookalike would be a different person.
 *
 * The unlinked rest fall back to name matching with the same rules the
 * inbound calendar sync uses, against only the Jobber users nobody is linked
 * to — an ambiguous name is no match, because putting the wrong cleaner on a
 * customer's job is worse than sending the visit out unassigned and saying
 * so. An unambiguous name match is used provisionally for this push only.
 * Durable links are owner-confirmed from the Team page.
 *
 * Matches must also be one-to-one across the crew: two unlinked seats
 * claiming the same Jobber user means the name told us nothing about which
 * of them that user is. Assigning them both would send one person two
 * people's jobs, so both are reported unmatched instead.
 */
export function resolveCrewToJobberUsers(
  crew: OutboundCrewMember[],
  jobberUsers: Array<{ id: string; name: string }>,
  linkedJobberIds: Set<string>,
): {
  userIds: string[];
  unmatched: string[];
} {
  const activeIds = new Set(jobberUsers.map((u) => u.id));
  // Jobber users already spoken for by a link are not name-match candidates:
  // their staff member reaches them by id, and nobody else may.
  const candidates = jobberUsers.filter((u) => !linkedJobberIds.has(u.id));
  // matchAssigneesToRoster works in numeric ids, so the candidates stand in
  // as the "roster" by index and are mapped back afterwards.
  const candidateRoster: RosterMember[] = candidates.map((u, index) => ({
    id: index,
    name: u.name,
  }));

  const userIds: string[] = [];
  const unmatched: string[] = [];

  // First pass: provisional name matches for the unlinked seats. They are
  // used for this push only; an owner must confirm any durable link.
  const provisional: Array<{
    memberId: number;
    name: string;
    jobberUserId: string;
  }> = [];
  for (const member of crew) {
    const name = member.name.trim();
    if (member.jobberUserId) {
      if (activeIds.has(member.jobberUserId)) userIds.push(member.jobberUserId);
      else if (name) unmatched.push(name);
      continue;
    }
    if (!name) continue;
    const { matchedIds } = matchAssigneesToRoster([name], candidateRoster);
    if (matchedIds.length === 1) {
      const user = candidates[matchedIds[0]!]!;
      provisional.push({ memberId: member.id, name, jobberUserId: user.id });
    } else {
      unmatched.push(name);
    }
  }

  // Second pass: keep only the one-to-one matches.
  const claims = new Map<string, number>();
  for (const p of provisional) {
    claims.set(p.jobberUserId, (claims.get(p.jobberUserId) ?? 0) + 1);
  }
  for (const p of provisional) {
    if (claims.get(p.jobberUserId)! > 1) {
      unmatched.push(p.name);
      continue;
    }
    userIds.push(p.jobberUserId);
  }

  return {
    userIds: [...new Set(userIds)],
    unmatched: [...new Set(unmatched)],
  };
}

export async function matchCrewToJobberUsers(
  accessToken: string,
  bookingId: number,
): Promise<{ userIds: string[]; unmatched: string[] }> {
  const crew: Array<OutboundCrewMember & { companyId: number }> = await db
    .select({
      id: teamMembersTable.id,
      name: teamMembersTable.name,
      jobberUserId: teamMembersTable.jobberUserId,
      companyId: teamMembersTable.companyId,
    })
    .from(bookingAssignmentsTable)
    .innerJoin(
      teamMembersTable,
      eq(teamMembersTable.id, bookingAssignmentsTable.teamMemberId),
    )
    .where(eq(bookingAssignmentsTable.bookingId, bookingId));
  if (crew.length === 0) return { userIds: [], unmatched: [] };
  const companyId = crew[0]!.companyId;

  // Every link in the company, not just this crew's: a Jobber user linked to
  // someone who happens not to be on this booking is still spoken for.
  const linkedRows = await db
    .select({ jobberUserId: teamMembersTable.jobberUserId })
    .from(teamMembersTable)
    .where(
      and(
        eq(teamMembersTable.companyId, companyId),
        isNotNull(teamMembersTable.jobberUserId),
      ),
    );
  const linkedJobberIds = new Set(
    linkedRows.flatMap((r) => (r.jobberUserId ? [r.jobberUserId] : [])),
  );

  const jobberUsers = await listJobberUsers(accessToken);
  const { userIds, unmatched } = resolveCrewToJobberUsers(
    crew,
    jobberUsers,
    linkedJobberIds,
  );
  return { userIds, unmatched };
}

/* ───────────────────────────── approving ───────────────────────────── */

export type ApproveBookingResult = {
  booking: Booking;
  /** True when this call is what recorded the approval, not an earlier one. */
  recorded: boolean;
  /** True once the job sits on the Jobber calendar. */
  scheduledInJobber: boolean;
  /** Cleaners with no confident Jobber user — the visit went out without them. */
  unmatchedCrew: string[];
  /** What Jobber refused, if anything. The recorded approval still stands. */
  jobberError: string | null;
};

/**
 * Record that the client agreed, or put an already-approved quote on Jobber's
 * calendar.
 *
 * These are deliberately separate operations. Scheduling never manufactures
 * a Book My Cleaning approval, so the UI can keep saying where the approval
 * was actually observed. Both operations are idempotent.
 */
export async function approveBooking(
  company: Company,
  booking: Booking,
  options: {
    schedule: boolean;
    recordedBy: string | null;
    approvalObservedInJobber?: boolean;
  },
): Promise<ApproveBookingResult> {
  const result: ApproveBookingResult = {
    booking,
    recorded: false,
    scheduledInJobber: Boolean(scheduledJobberJobId(booking)),
    unmatchedCrew: [],
    jobberError: null,
  };

  const approvalAlreadyRecorded = Boolean(
    booking.clientApprovedAt ||
    booking.quoteApprovedAt ||
    options.approvalObservedInJobber,
  );

  if (options.schedule && !approvalAlreadyRecorded) {
    throw new Error(
      "Record the client's approval before scheduling this job in Jobber.",
    );
  }

  // 1. Approval-only: claim the local fact conditionally so two clicks record
  //    one approval and one activity line. A quote-link or Jobber approval
  //    already carries its own provenance and must not be relabelled as local.
  if (!options.schedule && !approvalAlreadyRecorded) {
    const [recorded] = await db
      .update(bookingsTable)
      .set({
        clientApprovedAt: new Date(),
        clientApprovedBy: options.recordedBy,
        // Approval is exactly what "confirmed" now means. A job already
        // completed or cancelled keeps the status it earned.
        ...(booking.status === "pending" ? { status: "confirmed" } : {}),
      })
      .where(
        and(
          eq(bookingsTable.id, booking.id),
          eq(bookingsTable.companyId, company.id),
          isNull(bookingsTable.clientApprovedAt),
        ),
      )
      .returning();
    if (recorded) {
      result.booking = recorded;
      result.recorded = true;
      await db.insert(activityTable).values({
        companyId: company.id,
        type: "quote_approved",
        message: options.recordedBy
          ? `${customerLabel(booking)} approved their quote — recorded by ${options.recordedBy}.`
          : `${customerLabel(booking)} approved their quote.`,
        bookingId: booking.id,
      });
    } else {
      // Somebody else got there first; work from what is actually stored.
      const [current] = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, booking.id));
      result.booking = current ?? booking;
      result.scheduledInJobber = Boolean(scheduledJobberJobId(result.booking));
    }
  }

  // Approval-only ends here. Jobber does not expose a supported quoteApprove
  // mutation, and an owner recording what a client said must never depend on
  // the integration being online.
  if (!options.schedule) return result;

  // A quote approved in Jobber can still have a stale local "pending" status.
  // Confirm the booking without stamping a local approval source.
  if (result.booking.status === "pending") {
    const [confirmed] = await db
      .update(bookingsTable)
      .set({ status: "confirmed" })
      .where(
        and(
          eq(bookingsTable.id, result.booking.id),
          eq(bookingsTable.companyId, company.id),
          eq(bookingsTable.status, "pending"),
        ),
      )
      .returning();
    if (confirmed) result.booking = confirmed;
  }

  // A valid approval was established above. If this booking already carries
  // the Jobber job id, scheduling is idempotently complete and needs no token.
  if (scheduledJobberJobId(result.booking)) return result;

  // 2. Explicit scheduling. Never allowed to alter the approval source.
  const quoteId = realQuoteId(result.booking);
  if (!quoteId) {
    result.jobberError = null;
    return result;
  }
  if (
    company.jobberNeedsReauth ||
    !company.jobberConnected ||
    !company.jobberRefreshToken
  ) {
    return result;
  }

  try {
    const accessToken = await getValidAccessToken(company);
    if (!scheduledJobberJobId(result.booking)) {
      const scheduled = await scheduleApprovedQuote(
        company,
        result.booking,
        accessToken,
        quoteId,
      );
      result.booking = scheduled.booking;
      result.scheduledInJobber = scheduled.scheduled;
      result.unmatchedCrew = scheduled.unmatched;
      if (scheduled.error) result.jobberError = scheduled.error;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error(
      { err, bookingId: booking.id },
      "Scheduling the booking in Jobber failed",
    );
    result.booking = await recordJobberFailure(
      company,
      result.booking,
      message,
    );
    result.jobberError = message;
  }

  if (result.scheduledInJobber && !result.jobberError) {
    result.booking = await clearNonContactJobberFailure(result.booking);
  }
  return result;
}

/**
 * Convert an approved quote into a scheduled Jobber job.
 *
 * Two clicks must never become two cleans, and neither must a click whose
 * record was lost, so this is defended on both sides of the call to Jobber:
 * the booking is claimed before dialling out, Jobber is asked whether it
 * already made a job from this quote, and the id it returns is written even
 * if the claim vanished while it was answering.
 */
async function scheduleApprovedQuote(
  company: Company,
  booking: Booking,
  accessToken: string,
  quoteId: string,
): Promise<{
  booking: Booking;
  scheduled: boolean;
  unmatched: string[];
  error: string | null;
}> {
  const prior = booking.jobberCreatedJobId;
  const priorAge = isScheduleClaim(prior)
    ? Number(prior!.slice(SCHEDULE_CLAIM_PREFIX.length))
    : null;
  if (
    priorAge !== null &&
    Number.isFinite(priorAge) &&
    priorAge > Date.now() - SCHEDULE_CLAIM_STALE_MS
  ) {
    return {
      booking,
      scheduled: false,
      unmatched: [],
      error: "This job is already being scheduled in Jobber.",
    };
  }

  const claim = `${SCHEDULE_CLAIM_PREFIX}${Date.now()}`;
  const claimed = await db
    .update(bookingsTable)
    .set({ jobberCreatedJobId: claim })
    .where(
      and(
        eq(bookingsTable.id, booking.id),
        eq(bookingsTable.companyId, company.id),
        prior === null
          ? isNull(bookingsTable.jobberCreatedJobId)
          : eq(bookingsTable.jobberCreatedJobId, prior),
      ),
    )
    .returning();
  if (claimed.length === 0) {
    return {
      booking,
      scheduled: false,
      unmatched: [],
      error: "This job is already being scheduled in Jobber.",
    };
  }

  let unmatched: string[] = [];
  let job: JobberScheduledJob;
  try {
    const match = await matchCrewToJobberUsers(accessToken, booking.id);
    unmatched = match.unmatched;
    const window = bookingWindow(company, booking);

    // Ask Jobber first. A job it already made from this quote — because an
    // earlier attempt's record never reached us — must be adopted, not
    // duplicated: the customer would otherwise get two cleans booked.
    const existing = await fetchJobberJobForQuote(accessToken, quoteId);
    if (existing) {
      logger.warn(
        { bookingId: booking.id, jobId: existing.id },
        "Jobber already had a job for this quote; adopting it instead of creating another",
      );
    }
    job =
      existing ??
      (await createJobberJobFromQuote(accessToken, {
        quoteId,
        startDate: window.start.date,
        startTime: window.start.time,
        endTime: window.end.time,
        assignedUserIds: match.userIds,
      }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error(
      { err, bookingId: booking.id },
      "Scheduling the job in Jobber failed",
    );
    // Nothing was created, so release the claim and let the office retry.
    await releaseScheduleClaim(booking.id, claim, prior);
    const recorded = await recordJobberFailure(company, booking, message);
    return {
      booking: recorded,
      scheduled: false,
      unmatched: [],
      error: message,
    };
  }

  // Past this line Jobber has the job. Its id must reach the database, or the
  // next attempt schedules the same clean again — everything below is written
  // to give that id somewhere to land even when the claim is gone.
  const visitId =
    job.visitId ?? (await fetchJobberFirstVisitId(accessToken, job.id));
  const stored = await storeScheduledJob(booking.id, claim, job, visitId);

  if (!stored) {
    // Somebody else's write is sitting on this booking and it names a
    // different job. Say so: an untracked job on the calendar is exactly the
    // duplicate this whole path exists to prevent, and only a person can
    // sort it out in Jobber.
    logger.error(
      { bookingId: booking.id, jobId: job.id },
      "Scheduled a Jobber job but the booking already points at another one",
    );
    const message = `A job (${job.id}) was created in Jobber for this quote while another was already recorded here. Check the Jobber calendar for a duplicate.`;
    const recorded = await recordJobberFailure(company, booking, message);
    return {
      booking: recorded,
      scheduled: false,
      unmatched,
      error: message,
    };
  }

  await db.insert(activityTable).values({
    companyId: company.id,
    type: "jobber_synced",
    message:
      unmatched.length > 0
        ? `${customerLabel(booking)}'s job was scheduled in Jobber — ${unmatched.join(", ")} could not be matched to a Jobber user, so the visit went out unassigned to them.`
        : `${customerLabel(booking)}'s job was scheduled in Jobber.`,
    bookingId: booking.id,
  });

  return { booking: stored, scheduled: true, unmatched, error: null };
}

/** Put the claim marker back the way it was, so the office can try again. */
async function releaseScheduleClaim(
  bookingId: number,
  claim: string,
  prior: string | null,
): Promise<void> {
  await db
    .update(bookingsTable)
    .set({ jobberCreatedJobId: prior })
    .where(
      and(
        eq(bookingsTable.id, bookingId),
        eq(bookingsTable.jobberCreatedJobId, claim),
      ),
    );
}

/**
 * Record the job Jobber just created.
 *
 * Normally our claim is still there and this is one conditional update. If it
 * isn't — a stale-claim retry took it while Jobber was answering — the id is
 * still written, as long as the booking doesn't already name a *real* job:
 * dropping it would leave work on the customer's calendar that this app can
 * neither point at nor move. Returns null only when the booking genuinely
 * belongs to a different job, which a person has to untangle.
 */
async function storeScheduledJob(
  bookingId: number,
  claim: string,
  job: JobberScheduledJob,
  visitId: string | null,
): Promise<Booking | null> {
  const fields = {
    jobberCreatedJobId: job.id,
    jobberCreatedVisitId: visitId,
    jobberJobWebUri: job.webUri,
    ...nonContactJobberSuccessFields(),
  };

  const [updated] = await db
    .update(bookingsTable)
    .set(fields)
    .where(
      and(
        eq(bookingsTable.id, bookingId),
        eq(bookingsTable.jobberCreatedJobId, claim),
      ),
    )
    .returning();
  if (updated) return updated;

  // The claim went; take the slot anyway unless a real job id holds it.
  const [rescued] = await db
    .update(bookingsTable)
    .set(fields)
    .where(
      and(
        eq(bookingsTable.id, bookingId),
        or(
          isNull(bookingsTable.jobberCreatedJobId),
          like(bookingsTable.jobberCreatedJobId, `${SCHEDULE_CLAIM_PREFIX}%`),
          eq(bookingsTable.jobberCreatedJobId, job.id),
        ),
      ),
    )
    .returning();
  return rescued ?? null;
}

/* ─────────────────── keeping the two calendars in step ─────────────────── */

export type VisitSyncChange = { time?: boolean; crew?: boolean };

/**
 * Move or reassign the Jobber visit this booking created, after its time or
 * crew changed here.
 *
 * Returns quietly for a booking that was never scheduled from the app — a
 * booking imported *from* Jobber is Jobber's to move, and one that only ever
 * existed here has no visit to touch. A visit that can't be updated is
 * recorded on the booking like any other sync failure, never swallowed: two
 * calendars silently disagreeing is exactly what this is meant to prevent.
 */
export async function syncScheduledVisit(
  company: Company,
  booking: Booking,
  change: VisitSyncChange,
): Promise<{ status: "updated" | "skipped" | "failed"; error?: string }> {
  if (!change.time && !change.crew) return { status: "skipped" };
  // Read the row again rather than trusting the copy the caller was holding
  // before it edited the booking: what matters here is which Jobber job the
  // booking points at *now*, and a fire-and-forget call can run well after
  // the row it was handed was fetched.
  const [current] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.id, booking.id));
  booking = current ?? booking;
  if (!scheduledJobberJobId(booking)) return { status: "skipped" };
  if (
    company.jobberNeedsReauth ||
    !company.jobberConnected ||
    !company.jobberRefreshToken
  ) {
    return { status: "skipped" };
  }
  const visitId = booking.jobberCreatedVisitId;
  if (!visitId) {
    const message =
      "This job is in Jobber but its visit couldn't be identified, so the new time wasn't sent over. Move it in Jobber too.";
    await recordJobberFailure(company, booking, message);
    return { status: "failed", error: message };
  }

  try {
    const accessToken = await getValidAccessToken(company);
    if (change.time) {
      const window = bookingWindow(company, booking);
      await editJobberVisitSchedule(accessToken, {
        visitId,
        startDate: window.start.date,
        startTime: window.start.time,
        endDate: window.end.date,
        endTime: window.end.time,
        timezone: company.timezone,
      });
    }
    if (change.crew) {
      const { userIds } = await matchCrewToJobberUsers(accessToken, booking.id);
      await editJobberVisitAssignedUsers(accessToken, {
        visitId,
        assignedUserIds: userIds,
      });
    }
    await clearNonContactJobberFailure(booking);
    return { status: "updated" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error(
      { err, bookingId: booking.id },
      "Updating the Jobber visit failed",
    );
    await recordJobberFailure(
      company,
      booking,
      `Could not update this job's Jobber visit: ${message}`,
    );
    return { status: "failed", error: message };
  }
}

/**
 * Fire-and-forget visit update for the routes that edit a booking. Waits
 * behind any other Jobber work for the company — the rate budget is shared —
 * and never throws: the failure is already on the booking.
 *
 * The returned promise exists for tests; production callers ignore it.
 */
export function scheduleVisitSync(
  company: Company,
  booking: Booking,
  change: VisitSyncChange,
): Promise<void> {
  if (!scheduledJobberJobId(booking)) return Promise.resolve();
  if (!change.time && !change.crew) return Promise.resolve();
  return runQueuedForCompany(company.id, () =>
    syncScheduledVisit(company, booking, change),
  )
    .then(() => undefined)
    .catch((err) => {
      logger.error(
        { err, bookingId: booking.id },
        "Background Jobber visit sync threw",
      );
    });
}
