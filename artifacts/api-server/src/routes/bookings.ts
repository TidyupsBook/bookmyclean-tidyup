import { Router, type IRouter, type Request, type Response } from "express";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  db,
  bookingsTable,
  bookingAssignmentsTable,
  bookingTimeEntriesTable,
  teamMembersTable,
  servicesTable,
  callsTable,
  activityTable,
  leadsTable,
  jobberQuotesTable,
  savedRoutesTable,
  savedRouteStopsTable,
  type Booking,
  type BookingTimeEntry,
} from "@workspace/db";
import {
  ListBookingsResponse,
  ListBookingsQueryParams,
  ListBookingsInRangeQueryParams,
  ListBookingsInRangeResponse,
  CreateBookingBody,
  CreateBookingResponse,
  GetBookingParams,
  GetBookingResponse,
  UpdateBookingParams,
  UpdateBookingBody,
  UpdateBookingResponse,
  GetQuotePreviewParams,
  GetQuotePreviewResponse,
  SendQuoteParams,
  SendQuoteBody,
  SendQuoteResponse,
  SyncBookingToJobberParams,
  SyncBookingToJobberResponse,
  ConfirmBookingTimeParams,
  ConfirmBookingTimeResponse,
  SendRescheduleTextParams,
  SendRescheduleTextBody,
  SendRescheduleTextResponse,
  GetRescheduleTextPreviewParams,
  GetRescheduleTextPreviewResponse,
  SetBookingCrewParams,
  SetBookingCrewBody,
  SetBookingCrewResponse,
  StartBookingTimerParams,
  StartBookingTimerResponse,
  StopBookingTimerParams,
  StopBookingTimerResponse,
  CreateBookingInvoiceParams,
  CreateBookingInvoiceResponse,
  ApproveBookingParams,
  ApproveBookingBody,
  ApproveBookingResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireRole } from "../middlewares/requireRole";
import { getCompanyForUser, companyQuoKey } from "../lib/company";
import { customerLabel } from "../lib/bookingFormat";
import {
  missingRequiredBookingFields,
  missingFieldsMessage,
} from "../lib/bookingRequiredFields";
import { bookingHistoryFloor, companyDayBounds } from "../lib/dayBounds";
import { getCaller } from "../middlewares/requireRole";
import { listPhoneNumbers, sendMessage, toE164 } from "../lib/quo";
import { loadUnplaceableAddressKeys } from "../services/geocodeBackfill";
import { geocodeCacheKey } from "../services/geocode";
import {
  buildQuoteMessage,
  computeQuoteTotals,
  formatAppointment,
} from "../lib/quotes";
import {
  messageContainsQuotePrice,
  formatMoney,
  quotedPriceAnchor,
} from "@workspace/pricing";
import { ensureQuoteToken, quoteUrl } from "./publicQuote";
import type { Company } from "@workspace/db";
import {
  getValidAccessToken,
  JobberTaxConfigurationError,
  verifyJobberTaxConfiguration,
  createJobberInvoice,
  createJobberJobNote,
  tryAttachRequestNote,
  getJobberInvoiceWebUri,
} from "../lib/jobber";
import {
  queueQuotePush,
  scheduleJobberPush,
  serviceLabel,
  isClaim,
} from "../services/jobberPush";
import {
  bookingJobberManualSyncBlockedReason,
  queueBookingJobberSync,
} from "../services/bookingJobberSync";
import { bookingJobberRetryState } from "../services/bookingJobberRetry";
import { resolveChatSeat } from "../lib/staffChat";
import {
  approveBooking,
  scheduleBlockedReason,
  scheduledJobberJobId,
  scheduleVisitSync,
} from "../services/jobberSchedule";
import { scheduleBookingClientUpdate } from "../services/jobberClientSync";
import { joinAddress, frequencyLabel } from "../lib/bookingFormat";
import { recordClientContact } from "../services/clientDirectory";
import { logger } from "../lib/logger";
import { redactBookingForCleaner } from "../lib/bookingVisibility";
import {
  summarizeTimeEntries,
  entryMinutes,
  formatWorkedTime,
} from "../lib/jobTimer";

const router: IRouter = Router();

router.use(requireAuth);

type CrewMember = {
  id: number;
  name: string;
  role: string;
  color: string | null;
};

/**
 * Crews for a set of bookings, keyed by booking id. Loaded in one query so a
 * long schedule does not fan out into a lookup per job.
 */
async function loadCrews(
  bookingIds: number[],
): Promise<Map<number, CrewMember[]>> {
  const crews = new Map<number, CrewMember[]>();
  if (bookingIds.length === 0) return crews;

  const rows = await db
    .select({
      bookingId: bookingAssignmentsTable.bookingId,
      id: teamMembersTable.id,
      name: teamMembersTable.name,
      role: teamMembersTable.role,
      color: teamMembersTable.color,
    })
    .from(bookingAssignmentsTable)
    .innerJoin(
      teamMembersTable,
      eq(bookingAssignmentsTable.teamMemberId, teamMembersTable.id),
    )
    .where(
      and(
        inArray(bookingAssignmentsTable.bookingId, bookingIds),
        eq(teamMembersTable.active, true),
      ),
    )
    .orderBy(teamMembersTable.name);

  for (const row of rows) {
    const list = crews.get(row.bookingId) ?? [];
    list.push({
      id: row.id,
      name: row.name,
      role: row.role,
      color: row.color,
    });
    crews.set(row.bookingId, list);
  }
  return crews;
}

/**
 * Clocked time for a set of bookings, keyed by booking id. One query for the
 * whole list, same as the crews above — a busy schedule must not turn into a
 * lookup per job.
 */
async function loadTimeEntries(
  companyId: number,
  bookingIds: number[],
): Promise<Map<number, BookingTimeEntry[]>> {
  const byBooking = new Map<number, BookingTimeEntry[]>();
  if (bookingIds.length === 0) return byBooking;

  const rows = await db
    .select()
    .from(bookingTimeEntriesTable)
    .where(
      and(
        eq(bookingTimeEntriesTable.companyId, companyId),
        inArray(bookingTimeEntriesTable.bookingId, bookingIds),
      ),
    )
    .orderBy(bookingTimeEntriesTable.startedAt);

  for (const row of rows) {
    const list = byBooking.get(row.bookingId) ?? [];
    list.push(row);
    byBooking.set(row.bookingId, list);
  }
  return byBooking;
}

/** The clocked time for one booking, for the routes that answer with a single job. */
async function timeEntriesFor(
  companyId: number,
  bookingId: number,
): Promise<BookingTimeEntry[]> {
  return (await loadTimeEntries(companyId, [bookingId])).get(bookingId) ?? [];
}

/** When a booking carries no duration, fall back to the service, else two hours. */
const DEFAULT_DURATION_MINUTES = 120;

/** Each service's own length, for bookings that never recorded one. */
async function loadServiceDurations(
  companyId: number,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      name: servicesTable.name,
      durationMinutes: servicesTable.durationMinutes,
    })
    .from(servicesTable)
    .where(eq(servicesTable.companyId, companyId));

  const byName = new Map<string, number>();
  for (const row of rows) {
    if (row.durationMinutes !== null) byName.set(row.name, row.durationMinutes);
  }
  return byName;
}

/**
 * The subset of `requested` that this company may actually put on a job.
 *
 * Only this company's own people, so a guessed id cannot put a stranger on the
 * schedule or leak their name back in the response. Off the roster means off
 * the schedule too — enforced here rather than only hidden in the picker, so
 * the toggle on the staff card is a real rule and not a suggestion.
 *
 * Callers compare the length against what they asked for: a short result means
 * at least one id was somebody else's, or somebody switched off.
 */
async function eligibleCrew(
  companyId: number,
  requested: number[],
): Promise<CrewMember[]> {
  if (requested.length === 0) return [];
  return db
    .select({
      id: teamMembersTable.id,
      name: teamMembersTable.name,
      role: teamMembersTable.role,
      color: teamMembersTable.color,
    })
    .from(teamMembersTable)
    .where(
      and(
        eq(teamMembersTable.companyId, companyId),
        inArray(teamMembersTable.id, requested),
        eq(teamMembersTable.active, true),
      ),
    );
}

export { joinAddress } from "../lib/bookingFormat";

/**
 * Jobber may have seen an approval that was never recorded in this app. Keep
 * that mirrored status separate rather than manufacturing a local approval.
 */
async function loadJobberQuoteStatuses(
  companyId: number,
  bookings: Booking[],
): Promise<Map<string, string>> {
  const quoteIds = [
    ...new Set(
      bookings.flatMap((booking) =>
        booking.jobberQuoteId ? [booking.jobberQuoteId] : [],
      ),
    ),
  ];
  if (quoteIds.length === 0) return new Map();

  const rows = await db
    .select({
      jobberQuoteId: jobberQuotesTable.jobberQuoteId,
      status: jobberQuotesTable.status,
    })
    .from(jobberQuotesTable)
    .where(
      and(
        eq(jobberQuotesTable.companyId, companyId),
        inArray(jobberQuotesTable.jobberQuoteId, quoteIds),
      ),
    );
  return new Map(rows.map((row) => [row.jobberQuoteId, row.status]));
}

function jobberApprovalObserved(status: string | null): boolean {
  const normalized = status?.toLowerCase();
  return normalized === "approved" || normalized === "converted";
}

function isRetiredQuoteApprovalError(error: string | null): boolean {
  return Boolean(
    error &&
    (/quoteApprove/i.test(error) ||
      /Variable \$id is declared by ApproveQuote but not used/i.test(error)),
  );
}

function serializeBooking(
  company: Company,
  b: Booking,
  crew: CrewMember[] = [],
  timeEntries: BookingTimeEntry[] = [],
  jobberQuoteStatus: string | null = null,
) {
  // Older releases tried a Jobber mutation that does not exist. Once this
  // release is live, that stale message is no longer an actionable sync error.
  const jobberSyncError = isRetiredQuoteApprovalError(b.jobberSyncError)
    ? null
    : b.jobberSyncError;
  const retryState = bookingJobberRetryState({
    ...b,
    jobberSyncError,
  });
  return {
    ...b,
    tag: b.tag ?? null,
    // On-site time. Defaulted to "nothing clocked" rather than omitted, so a
    // route that answers with a single booking still satisfies the contract —
    // but every route a dashboard reads from loads the real rows, or the card
    // would blink back to zero after an unrelated edit.
    ...summarizeTimeEntries(timeEntries),
    // Who is working the job. Defaulted rather than required so the many
    // existing call sites that respond with a single booking keep compiling.
    crew,
    scheduledFor: b.scheduledFor.toISOString(),
    // Nullable: only set once a quote has actually gone out. Forgetting this
    // breaks every booking response, not just the one that was quoted.
    quoteSentAt: b.quoteSentAt ? b.quoteSentAt.toISOString() : null,
    jobberSyncError,
    jobberSyncErrorAt:
      jobberSyncError && b.jobberSyncErrorAt
        ? b.jobberSyncErrorAt.toISOString()
        : null,
    jobberAutomaticRetryStatus: retryState.status,
    jobberAutomaticRetriesRemaining: retryState.attemptsRemaining,
    jobberNextRetryAt: retryState.nextRetryAt?.toISOString() ?? null,
    jobberRetryUsesBookingConnection: b.jobberConnectionId !== null,
    // Null for every booking invoiced before these columns existed — and
    // undefined fails the response schema, so they are pinned here.
    jobberInvoiceId:
      // An in-flight claim marker is not an invoice — clients must keep
      // treating the booking as uninvoiced while one request works on it.
      b.jobberInvoiceId && !b.jobberInvoiceId.startsWith("pending:")
        ? b.jobberInvoiceId
        : null,
    jobberInvoiceNumber: b.jobberInvoiceNumber ?? null,
    jobberInvoiceWebUri: b.jobberInvoiceWebUri ?? null,
    // Jobber-side links for the request and its quote. Pinned to null for
    // every booking synced before these columns existed — undefined fails
    // the response schema.
    jobberPropertyId: b.jobberPropertyId ?? null,
    jobberQuoteId: b.jobberQuoteId ?? null,
    jobberQuoteNumber: b.jobberQuoteNumber ?? null,
    jobberQuoteWebUri: b.jobberQuoteWebUri ?? null,
    jobberQuoteStatus,
    // Which Jobber object this booking was imported from, if any. Null for
    // bookings created here or synced in the other direction (push to Jobber).
    jobberSyncedRequestId: b.jobberSyncedRequestId ?? null,
    jobberSyncedQuoteId: b.jobberSyncedQuoteId ?? null,
    // The job we scheduled into Jobber ourselves. An in-flight claim marker is
    // not a job — while one request is talking to Jobber the booking is still
    // unscheduled as far as anybody else is concerned.
    jobberCreatedJobId: scheduledJobberJobId(b),
    jobberJobWebUri: b.jobberJobWebUri ?? null,
    // Who recorded the client's yes, and when. Distinct from quoteApprovedAt,
    // which is the customer's own tap on their quote link.
    clientApprovedAt: b.clientApprovedAt
      ? b.clientApprovedAt.toISOString()
      : null,
    clientApprovedBy: b.clientApprovedBy ?? null,
    createdAt: b.createdAt.toISOString(),
    // Derived so the dispatcher's card and the customer's text can never show
    // different totals.
    quoteTotals: computeQuoteTotals(company, b),
    // The frozen copy of whatever was actually texted, if anything was.
    quoteSentTotals: b.quoteSentTotals ?? null,
    quoteApprovedAt: b.quoteApprovedAt ? b.quoteApprovedAt.toISOString() : null,
    // Null until the quote has been previewed or sent, which is when the
    // customer's link is minted.
    quoteUrl: b.quoteToken ? quoteUrl(b.quoteToken) : null,
    depositPaidAt: b.depositPaidAt ? b.depositPaidAt.toISOString() : null,
    depositPaidAmount: b.depositPaidAmount ?? null,
    // Map/schedule fields. Serialized the same way as the other nullable
    // date/number columns so one geocoded row can't 500 the whole list: the
    // timestamp becomes an ISO string, the rest pass through or null out.
    lat: b.lat ?? null,
    lng: b.lng ?? null,
    geocodedAt: b.geocodedAt ? b.geocodedAt.toISOString() : null,
    durationMinutes: b.durationMinutes ?? null,
    // Intake detail collected on the phone. Explicitly nulled rather than
    // spread through, because every booking taken before these columns
    // existed has them undefined, and undefined fails the response schema.
    customerEmail: b.customerEmail ?? null,
    addressLine2: b.addressLine2 ?? null,
    addressCity: b.addressCity ?? null,
    addressProvince: b.addressProvince ?? null,
    addressPostal: b.addressPostal ?? null,
    bedrooms: b.bedrooms ?? null,
    bathrooms: b.bathrooms ?? null,
    extras: b.extras ?? null,
    frequency: b.frequency ?? null,
    internalNotes: b.internalNotes ?? null,
  };
}

/**
 * The calendar views on the live map need every booking in a span of days —
 * including the ones we couldn't put on the map, because "no pin" and "no job"
 * look identical to a dispatcher otherwise.
 *
 * Deliberately thin: a name, a time, who's on it, and whether it has a pin.
 * No price, no address, no phone number, so a cleaner can be served the exact
 * same rows as the owner without a redaction pass.
 *
 * Declared before `/bookings` and the `/bookings/:id` routes so Express
 * doesn't read "range" as an id.
 */
const MAX_RANGE_DAYS = 62;

router.get("/bookings/range", async (req, res): Promise<void> => {
  const query = ListBookingsInRangeQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const { start: startDate, end: endDate } = query.data;

  const caller = await getCaller(req);
  if (!caller.company) {
    res.json(
      ListBookingsInRangeResponse.parse({
        start: startDate,
        end: endDate,
        bookings: [],
      }),
    );
    return;
  }
  const company = caller.company;

  const from = companyDayBounds(startDate, company.timezone);
  const to = companyDayBounds(endDate, company.timezone);
  if (to.start < from.start) {
    res.status(400).json({ error: "end must not be before start" });
    return;
  }
  // A month grid spills into the neighbouring months, so the cap is generous —
  // it exists to stop a hand-typed range from pulling the whole table.
  const spanDays = Math.round(
    (to.start.getTime() - from.start.getTime()) / 86_400_000,
  );
  if (spanDays > MAX_RANGE_DAYS) {
    res
      .status(400)
      .json({ error: `range must be ${MAX_RANGE_DAYS} days or less` });
    return;
  }

  const inRange = and(
    eq(bookingsTable.companyId, company.id),
    // Month/week boards and their companion map use this feed. Pending work
    // remains exclusively in the Bookings queues until it is confirmed.
    inArray(bookingsTable.status, ["confirmed", "completed"]),
    gte(bookingsTable.scheduledFor, from.start),
    lt(bookingsTable.scheduledFor, to.end),
  );

  // Same rule as the bookings list: a cleaner only ever sees their own jobs.
  const scope =
    caller.role === "cleaner" && caller.teamMemberId !== null
      ? and(
          inRange,
          inArray(
            bookingsTable.id,
            db
              .select({ id: bookingAssignmentsTable.bookingId })
              .from(bookingAssignmentsTable)
              .where(
                eq(bookingAssignmentsTable.teamMemberId, caller.teamMemberId),
              ),
          ),
        )
      : inRange;

  const rows = await db
    .select({
      id: bookingsTable.id,
      customerName: bookingsTable.customerName,
      customerPhone: bookingsTable.customerPhone,
      service: bookingsTable.service,
      scheduledFor: bookingsTable.scheduledFor,
      durationMinutes: bookingsTable.durationMinutes,
      status: bookingsTable.status,
      lat: bookingsTable.lat,
      lng: bookingsTable.lng,
    })
    .from(bookingsTable)
    .where(scope)
    .orderBy(bookingsTable.scheduledFor);

  const crews = await loadCrews(rows.map((r) => r.id));
  const serviceDuration = await loadServiceDurations(company.id);

  res.json(
    ListBookingsInRangeResponse.parse({
      start: from.date,
      end: to.date,
      bookings: rows.map((r) => ({
        bookingId: r.id,
        // The calendar renders what it's given and a blank block would look
        // like a rendering bug, so a nameless booking is labeled here: the
        // phone number when there is one, else "No name".
        customerName: customerLabel(r),
        service: r.service,
        scheduledFor: r.scheduledFor.toISOString(),
        durationMinutes:
          r.durationMinutes ??
          serviceDuration.get(r.service) ??
          DEFAULT_DURATION_MINUTES,
        status: r.status,
        located: r.lat !== null && r.lng !== null,
        // The calendar colours a block by its first crew member, so their
        // colour rides along here — the crew view isn't allowed to read the
        // roster, and this is the only place it could learn it.
        assignees: (crews.get(r.id) ?? []).map((c) => ({
          teamMemberId: c.id,
          name: c.name,
          color: c.color,
        })),
      })),
    }),
  );
});

router.get("/bookings", async (req, res): Promise<void> => {
  const caller = await getCaller(req);
  if (!caller.company) {
    res.json(ListBookingsResponse.parse([]));
    return;
  }
  const company = caller.company;

  // Optional caller-supplied date window. Defaults to the history floor with
  // no upper bound — the same behaviour as before this param existed — but
  // callers that only need a narrow slice (e.g. the mobile home screen fetching
  // today/tomorrow, or the dashboard showing upcoming jobs) can pass a tight
  // window so the query stays fast as years of history accumulate.
  const parsed = ListBookingsQueryParams.safeParse(req.query);
  const historyFloor = bookingHistoryFloor(company.timezone);
  const requestedSince =
    parsed.success && parsed.data.since
      ? companyDayBounds(parsed.data.since, company.timezone).start
      : null;
  // Lower-bound: history floor or caller's since, whichever is later. A
  // caller-supplied since can never dig below the floor — that would reopen
  // the unbounded pre-migration scan this window exists to prevent.
  const windowSince =
    requestedSince && requestedSince > historyFloor
      ? requestedSince
      : historyFloor;
  const windowUntil =
    parsed.success && parsed.data.until
      ? companyDayBounds(parsed.data.until, company.timezone).end
      : null;

  const fromCutoff = windowUntil
    ? and(
        eq(bookingsTable.companyId, company.id),
        gte(bookingsTable.scheduledFor, windowSince),
        lt(bookingsTable.scheduledFor, windowUntil),
      )
    : and(
        eq(bookingsTable.companyId, company.id),
        gte(bookingsTable.scheduledFor, windowSince),
      );

  // A cleaner sees only the jobs they are actually on — the whole point of
  // the role. Filtered in SQL rather than after the fact so an unassigned
  // job never reaches their device.
  const scope =
    caller.role === "cleaner" && caller.teamMemberId !== null
      ? and(
          fromCutoff,
          inArray(
            bookingsTable.id,
            db
              .select({ id: bookingAssignmentsTable.bookingId })
              .from(bookingAssignmentsTable)
              .where(
                eq(bookingAssignmentsTable.teamMemberId, caller.teamMemberId),
              ),
          ),
        )
      : fromCutoff;

  const bookings = await db
    .select()
    .from(bookingsTable)
    .where(scope)
    .orderBy(desc(bookingsTable.createdAt));

  const crews = await loadCrews(bookings.map((b) => b.id));
  const times = await loadTimeEntries(
    company.id,
    bookings.map((b) => b.id),
  );
  const quoteStatuses =
    caller.role === "cleaner"
      ? new Map<string, string>()
      : await loadJobberQuoteStatuses(company.id, bookings);
  const unplaceableAddressKeys = await loadUnplaceableAddressKeys(
    bookings
      .map((booking) => booking.customerAddress)
      .filter((address): address is string => Boolean(address)),
  );

  // Pricing and Jobber state never leave the server for a crew login —
  // hidden UI on the phone is not a boundary; this is.
  const serialized = bookings.map((b) => {
    const s = serializeBooking(
      company,
      b,
      crews.get(b.id) ?? [],
      times.get(b.id) ?? [],
      b.jobberQuoteId ? (quoteStatuses.get(b.jobberQuoteId) ?? null) : null,
    );
    const withGeocodeState = {
      ...s,
      geocodingFailed:
        b.lat === null &&
        b.lng === null &&
        b.customerAddress !== null &&
        unplaceableAddressKeys.has(geocodeCacheKey(b.customerAddress)),
    };
    return caller.role === "cleaner"
      ? redactBookingForCleaner(withGeocodeState)
      : withGeocodeState;
  });

  res.json(ListBookingsResponse.parse(serialized));
});

router.put(
  "/bookings/:id/crew",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = SetBookingCrewParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = SetBookingCrewBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const caller = await getCaller(req);
    if (!caller.company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    const company = caller.company;

    const [booking] = await db
      .select()
      .from(bookingsTable)
      .where(
        and(
          eq(bookingsTable.id, params.data.id),
          eq(bookingsTable.companyId, company.id),
        ),
      );
    if (!booking) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }

    const requested = [...new Set(parsed.data.teamMemberIds)];
    const eligible = await eligibleCrew(company.id, requested);

    if (eligible.length !== requested.length) {
      res.status(400).json({
        error: "One or more people are not on your team, or are off the roster",
      });
      return;
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(bookingAssignmentsTable)
        .where(eq(bookingAssignmentsTable.bookingId, booking.id));
      if (eligible.length > 0) {
        await tx.insert(bookingAssignmentsTable).values(
          eligible.map((m) => ({
            bookingId: booking.id,
            teamMemberId: m.id,
          })),
        );
      }
    });

    await db.insert(activityTable).values({
      companyId: company.id,
      type: "crew_assigned",
      message:
        eligible.length > 0
          ? `${eligible.map((m) => m.name).join(", ")} assigned to ${customerLabel(booking)}'s job.`
          : `Crew cleared from ${customerLabel(booking)}'s job.`,
      bookingId: booking.id,
    });

    const crews = await loadCrews([booking.id]);
    res.json(
      SetBookingCrewResponse.parse(
        serializeBooking(
          company,
          booking,
          crews.get(booking.id) ?? [],
          await timeEntriesFor(company.id, booking.id),
        ),
      ),
    );

    // Same for the crew: a job scheduled from here keeps its Jobber visit's
    // assignees in step, so nobody turns up to a job they were taken off.
    void scheduleVisitSync(company, booking, { crew: true });
  },
);

/**
 * One booking, everything the caller is allowed to know about it.
 *
 * The schedule board carries only enough to draw a block, so opening a client
 * has to ask for the rest. Scoped exactly like the list it came from: a
 * cleaner may only read a job they are actually on, and their copy goes
 * through the same redaction, so "not yours" and "no such booking" are the
 * same answer.
 */
router.get("/bookings/:id", async (req, res): Promise<void> => {
  const params = GetBookingParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const caller = await getCaller(req);
  const company = caller.company;
  if (!company) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }

  const [booking] = await db
    .select()
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.id, params.data.id),
        eq(bookingsTable.companyId, company.id),
      ),
    )
    .limit(1);
  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }

  const crew = (await loadCrews([booking.id])).get(booking.id) ?? [];
  if (caller.role === "cleaner") {
    const onThisJob =
      caller.teamMemberId !== null &&
      crew.some((c) => c.id === caller.teamMemberId);
    if (!onThisJob) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }
  }

  const serialized = serializeBooking(
    company,
    booking,
    crew,
    await timeEntriesFor(company.id, booking.id),
    caller.role === "cleaner" || !booking.jobberQuoteId
      ? null
      : ((await loadJobberQuoteStatuses(company.id, [booking])).get(
          booking.jobberQuoteId,
        ) ?? null),
  );
  res.json(
    GetBookingResponse.parse(
      caller.role === "cleaner"
        ? redactBookingForCleaner(serialized)
        : serialized,
    ),
  );
});

router.patch("/bookings/:id", async (req, res): Promise<void> => {
  const params = UpdateBookingParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateBookingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const caller = await getCaller(req);
  const company = caller.company;
  if (!company) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }
  const updates: Partial<typeof bookingsTable.$inferInsert> = {};
  const d = parsed.data;
  if (d.status !== undefined) updates.status = d.status;
  if (d.customerName !== undefined) updates.customerName = d.customerName;
  if (d.customerPhone !== undefined) updates.customerPhone = d.customerPhone;
  if (d.customerEmail !== undefined) updates.customerEmail = d.customerEmail;
  if (d.customerAddress !== undefined)
    updates.customerAddress = d.customerAddress;
  if (d.addressLine2 !== undefined) updates.addressLine2 = d.addressLine2;
  if (d.addressCity !== undefined) updates.addressCity = d.addressCity;
  if (d.addressProvince !== undefined)
    updates.addressProvince = d.addressProvince;
  if (d.addressPostal !== undefined) updates.addressPostal = d.addressPostal;
  if (d.service !== undefined) updates.service = d.service;
  if (d.bedrooms !== undefined) updates.bedrooms = d.bedrooms;
  if (d.bathrooms !== undefined) updates.bathrooms = d.bathrooms;
  if (d.extras !== undefined) updates.extras = d.extras;
  if (d.frequency !== undefined) updates.frequency = d.frequency;
  if (d.internalNotes !== undefined) updates.internalNotes = d.internalNotes;
  if (d.quoteHours !== undefined) updates.quoteHours = d.quoteHours;
  if (d.quoteCrewLabel !== undefined) updates.quoteCrewLabel = d.quoteCrewLabel;
  if (d.quoteHourlyRate !== undefined)
    updates.quoteHourlyRate = d.quoteHourlyRate;
  if (d.quoteFuelSurcharge !== undefined)
    updates.quoteFuelSurcharge = d.quoteFuelSurcharge;
  if (d.quoteDiscountAmount !== undefined)
    updates.quoteDiscountAmount = d.quoteDiscountAmount;
  if (d.quoteReferralSource !== undefined)
    updates.quoteReferralSource = d.quoteReferralSource;
  if (d.quotedAmount !== undefined) updates.quotedAmount = d.quotedAmount;
  if (d.quoteDeposit !== undefined) updates.quoteDeposit = d.quoteDeposit;
  if (d.quoteNotes !== undefined) updates.quoteNotes = d.quoteNotes;
  if (d.scheduledFor !== undefined) {
    const when = new Date(d.scheduledFor);
    if (Number.isNaN(when.getTime())) {
      res.status(400).json({ error: "Invalid scheduledFor date" });
      return;
    }
    updates.scheduledFor = when;
    // Rescheduling is itself the "adjust" half of the timezone review flow:
    // the owner has set the time deliberately in the current zone, so the
    // review flag no longer applies.
    updates.needsTimeReview = false;
    updates.timeReviewPreviousTimezone = null;
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }

  // A cleaner reports progress on their own job and nothing else: no pricing,
  // no rescheduling, no touching a job they were never sent to.
  if (caller.role === "cleaner") {
    const changesBeyondStatus = Object.keys(updates).some(
      (k) => k !== "status",
    );
    if (changesBeyondStatus) {
      res
        .status(403)
        .json({ error: "You can only update the status of your own jobs" });
      return;
    }
    const [assignment] = await db
      .select({ id: bookingAssignmentsTable.id })
      .from(bookingAssignmentsTable)
      .where(
        and(
          eq(bookingAssignmentsTable.bookingId, params.data.id),
          eq(bookingAssignmentsTable.teamMemberId, caller.teamMemberId!),
        ),
      )
      .limit(1);
    if (!assignment) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }
  }

  // "Confirmed" means the client said yes — through their quote link, or
  // recorded by the office. Typing it in by hand is what made the word
  // meaningless, so it is only accepted for a booking that already has an
  // approval on record. That is also what lets a finished job be reopened.
  if (d.status === "confirmed") {
    const current = await loadBooking(company.id, params.data.id);
    if (!current) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }
    if (!current.clientApprovedAt && !current.quoteApprovedAt) {
      res.status(400).json({
        error:
          "Use Approve to confirm a booking — confirmed means the client said yes.",
      });
      return;
    }
  }

  // Moving a job to a different address has to un-pin it. The stored
  // coordinates belong to the OLD house: leave them and the map keeps sending
  // the crew to the address that was just corrected. Clearing them hands the
  // booking back to the geocode backfill, which re-pins it on its next cycle.
  //
  // The comparison is done by the database inside the same UPDATE rather than
  // by reading the row first. Postgres evaluates every expression against the
  // pre-update row, so "did the address change" and "then drop the pin" can't
  // be split by a second edit landing in between and leaving a job wearing
  // some other address's coordinates.
  const addressChecks = [
    d.customerAddress !== undefined
      ? sql`${bookingsTable.customerAddress} is distinct from ${d.customerAddress ?? null}::text`
      : null,
    d.addressLine2 !== undefined
      ? sql`${bookingsTable.addressLine2} is distinct from ${d.addressLine2 ?? null}::text`
      : null,
    d.addressCity !== undefined
      ? sql`${bookingsTable.addressCity} is distinct from ${d.addressCity ?? null}::text`
      : null,
    d.addressProvince !== undefined
      ? sql`${bookingsTable.addressProvince} is distinct from ${d.addressProvince ?? null}::text`
      : null,
    d.addressPostal !== undefined
      ? sql`${bookingsTable.addressPostal} is distinct from ${d.addressPostal ?? null}::text`
      : null,
  ].filter((check): check is SQL => check !== null);

  const setValues: Record<string, unknown> = { ...updates };
  if (addressChecks.length > 0) {
    const moved = sql.join(addressChecks, sql` or `);
    setValues.lat = sql`case when (${moved}) then null else ${bookingsTable.lat} end`;
    setValues.lng = sql`case when (${moved}) then null else ${bookingsTable.lng} end`;
    setValues.geocodedAt = sql`case when (${moved}) then null else ${bookingsTable.geocodedAt} end`;
  }

  const [booking] = await db
    .update(bookingsTable)
    .set(setValues)
    .where(
      and(
        eq(bookingsTable.id, params.data.id),
        eq(bookingsTable.companyId, company.id),
      ),
    )
    .returning();
  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }
  const serialized = serializeBooking(
    company,
    booking,
    [],
    await timeEntriesFor(company.id, booking.id),
  );
  res.json(
    UpdateBookingResponse.parse(
      caller.role === "cleaner"
        ? redactBookingForCleaner(serialized)
        : serialized,
    ),
  );

  // Moving a job we put on the Jobber calendar has to move it there too, or
  // the crew's Jobber app keeps showing the old time. Fire-and-forget: the
  // desk already has its answer, and a failure lands on the booking.
  if (updates.scheduledFor !== undefined) {
    void scheduleVisitSync(company, booking, { time: true });
  }
  // A linked Jobber client follows customer corrections, but Jobber is never
  // allowed to hold the local save hostage. Failures are recorded on the
  // booking and retried through the existing Sync to Jobber action.
  if (
    booking.jobberClientId &&
    (updates.customerName !== undefined || updates.customerPhone !== undefined)
  ) {
    void scheduleBookingClientUpdate(company, booking);
  }
});

router.post(
  "/bookings",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const parsed = CreateBookingBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    const when = new Date(parsed.data.scheduledFor);
    if (Number.isNaN(when.getTime())) {
      res.status(400).json({ error: "Invalid scheduledFor date" });
      return;
    }

    // The owner's required-fields toggles, checked server-side so the three
    // booking forms can't drift apart on what "required" means — and so a
    // stale open tab can't slip past a toggle flipped a minute ago.
    const missing = missingRequiredBookingFields(
      company.bookingRequiredFields,
      parsed.data,
    );
    if (missing.length > 0) {
      res.status(400).json({ error: missingFieldsMessage(missing) });
      return;
    }

    // Checked before the insert, so a bad crew id doesn't leave a saved
    // booking behind with an error message on top of it — the dispatcher is
    // still on the phone and would have no idea it half-worked.
    const requestedCrew = [...new Set(parsed.data.teamMemberIds ?? [])];
    // A route stop is only a prefill/link; it never creates a booking itself.
    // Verify both halves are company-scoped before inserting anything, then add
    // the route's assigned cleaner through the ordinary crew assignment path.
    let routeStop: typeof savedRouteStopsTable.$inferSelect | null = null;
    let routeCleanerId: number | null = null;
    if (parsed.data.routeStopId != null) {
      const [found] = await db
        .select({
          stop: savedRouteStopsTable,
          teamMemberId: savedRoutesTable.teamMemberId,
        })
        .from(savedRouteStopsTable)
        .innerJoin(
          savedRoutesTable,
          eq(savedRouteStopsTable.routeId, savedRoutesTable.id),
        )
        .where(
          and(
            eq(savedRouteStopsTable.id, parsed.data.routeStopId),
            eq(savedRoutesTable.companyId, company.id),
          ),
        )
        .limit(1);
      if (!found) {
        res.status(400).json({ error: "Saved route stop not found" });
        return;
      }
      routeStop = found.stop;
      if (routeStop.linkedBookingId !== null) {
        res
          .status(409)
          .json({ error: "Saved route stop already has a booking" });
        return;
      }
      routeCleanerId = found.teamMemberId;
      if (!requestedCrew.includes(routeCleanerId))
        requestedCrew.push(routeCleanerId);
    }
    const eligible = await eligibleCrew(company.id, requestedCrew);
    if (eligible.length !== requestedCrew.length) {
      res.status(400).json({
        error: "One or more people are not on your team, or are off the roster",
      });
      return;
    }

    // Where the booking came from, when the desk worked it out of the Leads
    // inbox. Checked against this company the same way crew ids are: the id
    // arrives from a browser, and a booking wearing another company's lead id
    // would both leak that inbox and change how this booking reaches Jobber.
    let leadId: number | null = null;
    // A lead that came in through Jobber's own form already has a client,
    // property and request over there. The booking made from it wears those
    // ids so it attaches to what Jobber already has: `jobberSynced` plus the
    // request id make the outbound push refuse to mint a duplicate client or
    // request (jobberPushBlockedReason), exactly like a request the calendar
    // sync imported.
    let jobberOrigin: {
      requestId: string;
      clientId: string | null;
      propertyId: string | null;
      webUri: string | null;
    } | null = null;
    // A website-form lead is the mirror image: OUR push already created a
    // client + work request in Jobber, and those ids are stamped onto the
    // booking AT CREATION — the Jobber push starts the moment this insert
    // returns, so waiting for the follow-up convert call to copy the ids
    // would let the push race ahead and mint a second client. Outbound
    // columns only, never jobberSyncedRequestId: the booking must not look
    // imported, or it couldn't quote and schedule later. A claim marker
    // means the lead's push is still in flight; the push itself re-reads the
    // lead after queueing behind it (adoptLeadJobberState) to cover that.
    let leadJobberState: Partial<typeof bookingsTable.$inferInsert> = {};
    if (parsed.data.leadId != null) {
      const [lead] = await db
        .select()
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.id, parsed.data.leadId),
            eq(leadsTable.companyId, company.id),
          ),
        )
        .limit(1);
      if (!lead) {
        res.status(400).json({ error: "That lead isn't in your inbox." });
        return;
      }
      leadId = lead.id;
      if (lead.source === "jobber" && lead.jobberRequestId) {
        jobberOrigin = {
          requestId: lead.jobberRequestId,
          clientId: lead.jobberClientId,
          propertyId: lead.jobberPropertyId,
          webUri: lead.jobberWebUri,
        };
      } else if (lead.source === "form") {
        const leadRequestId =
          lead.jobberRequestId && !isClaim(lead.jobberRequestId)
            ? lead.jobberRequestId
            : null;
        if (leadRequestId) {
          leadJobberState = {
            jobberSynced: true,
            jobberJobId: leadRequestId,
            jobberClientId: lead.jobberClientId,
            jobberPropertyId: lead.jobberPropertyId,
            jobberWebUri: lead.jobberWebUri,
          };
        } else if (lead.jobberClientId) {
          // The lead's push failed after creating the client: reuse it, so
          // the booking's push raises the request on the same customer.
          leadJobberState = {
            jobberClientId: lead.jobberClientId,
            jobberPropertyId: lead.jobberPropertyId,
          };
        }
      }
    }

    // One transaction for the booking, its crew and the activity lines. The
    // dispatcher is on the phone: an error message must mean "nothing was
    // saved", never "saved, but nobody is assigned to it".
    const bookingPromise = db.transaction(async (tx) => {
      // The request sync may have imported this same Jobber request as a
      // pending booking before it became a lead (or during the switchover).
      // The desk working the lead is the real answer to that enquiry, so an
      // untouched pending twin is cancelled — and it hands over the request
      // id (a unique column) so the new booking, not the dead row, is the
      // one the request pull manages from now on. A twin the office already
      // touched keeps its id; the new booking still carries the client and
      // property so it can't push a duplicate client.
      let jobberRequestIdForBooking = jobberOrigin?.requestId ?? null;
      if (jobberOrigin) {
        const [twin] = await tx
          .select({ id: bookingsTable.id, status: bookingsTable.status })
          .from(bookingsTable)
          .where(
            and(
              eq(bookingsTable.companyId, company.id),
              eq(bookingsTable.jobberSyncedRequestId, jobberOrigin.requestId),
            ),
          )
          .limit(1);
        if (twin) {
          if (twin.status === "pending") {
            await tx
              .update(bookingsTable)
              .set({ status: "canceled", jobberSyncedRequestId: null })
              .where(
                and(
                  eq(bookingsTable.id, twin.id),
                  eq(bookingsTable.status, "pending"),
                ),
              );
          } else {
            jobberRequestIdForBooking = null;
          }
        }
      }
      const [row] = await tx
        .insert(bookingsTable)
        .values({
          companyId: company.id,
          // Hand-entered bookings have no originating call.
          callId: null,
          // May be blank: the owner can save a booking off nothing but a
          // phone number, and every display falls back through customerLabel.
          customerName: (parsed.data.customerName ?? "").trim(),
          // Both may arrive blank: the desk saves what it has while the
          // customer is still on the phone, and an unknown number or an
          // undecided service is not a reason to lose the booking.
          customerPhone: parsed.data.customerPhone ?? "",
          customerEmail: parsed.data.customerEmail ?? null,
          customerAddress: parsed.data.customerAddress ?? null,
          addressLine2: parsed.data.addressLine2 ?? null,
          addressCity: parsed.data.addressCity ?? null,
          addressProvince: parsed.data.addressProvince ?? null,
          addressPostal: parsed.data.addressPostal ?? null,
          service: parsed.data.service ?? "",
          bedrooms: parsed.data.bedrooms ?? null,
          bathrooms: parsed.data.bathrooms ?? null,
          extras: parsed.data.extras ?? null,
          frequency: parsed.data.frequency ?? null,
          internalNotes: parsed.data.internalNotes ?? null,
          leadId,
          ...leadJobberState,
          scheduledFor: when,
          // Always pending. "Confirmed" now means one thing — the client said
          // yes, through their quote link or recorded by the office — so a
          // booking cannot be typed in already wearing it.
          status: "pending",
          quoteHours: parsed.data.quoteHours ?? null,
          quoteCrewLabel: parsed.data.quoteCrewLabel ?? null,
          quoteHourlyRate: parsed.data.quoteHourlyRate ?? null,
          quoteFuelSurcharge: parsed.data.quoteFuelSurcharge ?? null,
          quoteDiscountAmount: parsed.data.quoteDiscountAmount ?? null,
          quoteReferralSource: parsed.data.quoteReferralSource ?? null,
          quotedAmount: parsed.data.quotedAmount ?? null,
          quoteDeposit: parsed.data.quoteDeposit ?? null,
          quoteNotes: parsed.data.quoteNotes ?? null,
          // A route stop may be an address-less map click. Preserve its exact
          // stored location rather than trying to manufacture a street address
          // (or leaving the new booking invisible on the dispatch map).
          ...(routeStop
            ? {
                lat: routeStop.lat,
                lng: routeStop.lng,
                geocodedAt: new Date(),
              }
            : {}),
          // Jobber-origin leads: this work is ALREADY in Jobber, so the
          // booking is born synced and pointing at the existing client,
          // property and request — never pushed back as new ones.
          ...(jobberOrigin
            ? {
                jobberSynced: true,
                jobberSyncedRequestId: jobberRequestIdForBooking,
                jobberClientId: jobberOrigin.clientId,
                jobberPropertyId: jobberOrigin.propertyId,
                jobberWebUri: jobberOrigin.webUri,
              }
            : {}),
        })
        .returning();

      if (eligible.length > 0) {
        await tx.insert(bookingAssignmentsTable).values(
          eligible.map((m) => ({
            bookingId: row!.id,
            teamMemberId: m.id,
          })),
        );
      }
      // This is intentionally after the booking insert and in its transaction:
      // a failed create cannot leave a stop claiming a booking that does not
      // exist, and map endpoints remain incapable of creating bookings.
      if (routeStop) {
        const linked = await tx
          .update(savedRouteStopsTable)
          .set({ linkedBookingId: row!.id, updatedAt: new Date() })
          .where(
            and(
              eq(savedRouteStopsTable.id, routeStop.id),
              eq(savedRouteStopsTable.routeId, routeStop.routeId),
              isNull(savedRouteStopsTable.linkedBookingId),
            ),
          )
          .returning({ id: savedRouteStopsTable.id });
        // A concurrent route deletion must roll the booking back rather than
        // leave an unlinked booking that the dispatcher thought came from it.
        if (linked.length === 0) {
          throw new Error("Saved route stop was already claimed or deleted");
        }
      }

      const activity = [
        {
          companyId: company.id,
          type: "booking_created",
          message: `Booking added by hand for ${customerLabel(row!)}${
            row!.service ? ` — ${row!.service}` : ""
          }.`,
          bookingId: row!.id,
        },
      ];
      if (eligible.length > 0) {
        activity.push({
          companyId: company.id,
          type: "crew_assigned",
          message: `${eligible.map((m) => m.name).join(", ")} assigned to ${customerLabel(row!)}'s job.`,
          bookingId: row!.id,
        });
      }
      await tx.insert(activityTable).values(activity);

      return row!;
    });
    const booking = await bookingPromise.catch((error: unknown) => {
      if (
        error instanceof Error &&
        error.message === "Saved route stop was already claimed or deleted"
      ) {
        return null;
      }
      throw error;
    });

    if (!booking) {
      res.status(409).json({ error: "Saved route stop already has a booking" });
      return;
    }

    res
      .status(201)
      .json(CreateBookingResponse.parse(serializeBooking(company, booking)));

    // Straight over to Jobber, after the desk has its answer. Nobody should
    // have to remember to press a button for a job they just took — unless
    // the work CAME from Jobber (a Jobber-form lead): it is already there,
    // and pushing would hand Jobber a duplicate client and request.
    if (!jobberOrigin) void scheduleJobberPush(company, booking);
    // And into the client directory, off the response path — recordClientContact
    // never throws, so the booking the desk just saved can't be undone by it.
    void recordClientContact(company.id, {
      name: booking.customerName,
      phone: booking.customerPhone,
      email: booking.customerEmail,
      streetAddress: booking.customerAddress,
      city: booking.addressCity,
      province: booking.addressProvince,
      postalCode: booking.addressPostal,
      source: booking.leadId != null ? "lead" : "booking",
    });
  },
);

/**
 * Works out which of the company's own Quo lines a quote should be sent from,
 * preferring the line the customer actually called so the thread stays in one
 * place. Returns a reason instead of throwing when sending isn't possible yet,
 * because the preview endpoint needs to explain the situation rather than fail.
 */
async function resolveQuoteSender(
  company: Company,
  booking: Booking,
): Promise<{ from: string } | { blockedReason: string }> {
  const apiKey = companyQuoKey(company);
  if (!apiKey) {
    return { blockedReason: "Connect your Quo account to text quotes." };
  }
  if (company.quoNumberIds.length === 0) {
    return {
      blockedReason:
        "Choose which Quo number your receptionist uses before texting quotes.",
    };
  }

  let preferredId: string | null = null;
  if (booking.callId != null) {
    const [call] = await db
      .select({ lineId: callsTable.quoPhoneNumberId })
      .from(callsTable)
      .where(
        and(
          eq(callsTable.id, booking.callId),
          eq(callsTable.companyId, company.id),
        ),
      );
    if (call?.lineId && company.quoNumberIds.includes(call.lineId)) {
      preferredId = call.lineId;
    }
  }
  const wantedId = preferredId ?? company.quoNumberIds[0]!;

  let numbers;
  try {
    numbers = await listPhoneNumbers(apiKey);
  } catch (err) {
    logger.warn({ err }, "Could not list Quo numbers for a quote");
    return {
      blockedReason:
        "Couldn't reach Quo to find your number. Try again shortly.",
    };
  }

  const match =
    numbers.find((n) => n.id === wantedId) ??
    numbers.find((n) => company.quoNumberIds.includes(n.id));
  if (!match) {
    return {
      blockedReason:
        "That Quo number is no longer in your workspace. Reconnect Quo to fix it.",
    };
  }
  return { from: match.number };
}

async function loadBooking(
  companyId: number,
  bookingId: number,
): Promise<Booking | undefined> {
  const [booking] = await db
    .select()
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.id, bookingId),
        eq(bookingsTable.companyId, companyId),
      ),
    );
  return booking;
}

router.get(
  "/bookings/:id/quote-preview",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = GetQuotePreviewParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }
    const booking = await loadBooking(company.id, params.data.id);
    if (!booking) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }

    const sender = await resolveQuoteSender(company, booking);
    const reachable = toE164(booking.customerPhone) !== null;
    // Minted here rather than at send time so the dispatcher sees the real link
    // in the draft, and so the same link is reused if they send twice.
    const token = await ensureQuoteToken(booking);

    res.json(
      GetQuotePreviewResponse.parse({
        // Always regenerated from the current price and time so edits show up,
        // even if an earlier version was already sent.
        message: buildQuoteMessage(company, booking, quoteUrl(token)),
        canSend: "from" in sender && reachable,
        blockedReason:
          "blockedReason" in sender
            ? sender.blockedReason
            : reachable
              ? null
              : "This customer's phone number isn't a number we can text.",
        fromNumber: "from" in sender ? sender.from : null,
        // Shown beside the draft so the dispatcher can check the maths against
        // the estimate before it goes to the customer.
        totals: computeQuoteTotals(company, booking),
      }),
    );
  },
);

router.post(
  "/bookings/:id/send-quote",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = SendQuoteParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = SendQuoteBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }
    const booking = await loadBooking(company.id, params.data.id);
    if (!booking) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }

    const to = toE164(booking.customerPhone);
    if (!to) {
      res.status(400).json({
        error: "This customer's phone number isn't a number we can text.",
      });
      return;
    }
    const sender = await resolveQuoteSender(company, booking);
    if ("blockedReason" in sender) {
      res.status(409).json({ error: sender.blockedReason });
      return;
    }
    // Normally already minted by the preview, but a send that skipped the
    // preview must not text a link that 404s.
    const token = await ensureQuoteToken(booking);
    const link = quoteUrl(token);
    // The dispatcher can edit the draft freely, and an edit that trims the
    // bottom off the message would otherwise send a quote the customer has no
    // way to read or approve. Put the link back rather than silently shipping a
    // dead end.
    const content = parsed.data.message.includes(link)
      ? parsed.data.message
      : `${parsed.data.message.trimEnd()}\n\nView your estimate here:\n${link}`;

    // The frozen quote below records the calculated price. If a hand-edit has
    // removed or changed that number in the text, the customer would be
    // promised one figure while the booking records another — refuse unless
    // the dispatcher has explicitly confirmed the mismatch in the dialog.
    const totals = computeQuoteTotals(company, booking);
    if (
      !messageContainsQuotePrice(content, totals) &&
      !parsed.data.confirmPriceMismatch
    ) {
      const anchor = quotedPriceAnchor(totals);
      res.status(409).json({
        error:
          `The message doesn't mention the calculated price of ${formatMoney(anchor ?? totals.total)}. ` +
          "Change the price in the booking's calculator, or confirm you want to send it anyway.",
      });
      return;
    }

    const apiKey = companyQuoKey(company);
    if (!apiKey) {
      res
        .status(409)
        .json({ error: "Connect your Quo account to text quotes." });
      return;
    }

    try {
      await sendMessage(apiKey, {
        from: sender.from,
        to,
        content,
      });
    } catch (err) {
      logger.error({ err }, "Quote text failed to send");
      res.status(502).json({
        error:
          err instanceof Error
            ? `Couldn't send the quote: ${err.message}`
            : "Couldn't send the quote",
      });
      return;
    }

    // Past this point the customer HAS the text. If bookkeeping fails we must not
    // report a plain failure — the dispatcher would resend and the customer would
    // get the quote twice.
    let updated;
    try {
      [updated] = await db
        .update(bookingsTable)
        .set({
          // Store what actually went out, link repair included — the dispatcher
          // reads this back to see what the customer was told.
          quoteMessage: content,
          quoteSentAt: new Date(),
          // Freeze the price at the moment of the promise. Every other total is
          // recomputed from current settings, which is right for a draft but
          // wrong for a commitment: if the owner edits their tax rate next month
          // this booking must still show what the customer was told.
          quoteSentTotals: totals,
        })
        .where(
          and(
            eq(bookingsTable.id, booking.id),
            eq(bookingsTable.companyId, company.id),
          ),
        )
        .returning();

      await db.insert(activityTable).values({
        companyId: company.id,
        type: "quote_sent",
        message: `Quote texted to ${customerLabel(booking)} at ${booking.customerPhone}.`,
      });
    } catch (err) {
      logger.error(
        { err, bookingId: booking.id, companyId: company.id },
        "Quote text was delivered but recording it failed",
      );
      res.status(500).json({
        error:
          "The quote was texted to the customer, but we couldn't save it against " +
          "this booking. Don't resend — they already have it.",
      });
      return;
    }

    res.json(
      SendQuoteResponse.parse(
        serializeBooking(
          company,
          updated!,
          [],
          await timeEntriesFor(company.id, updated!.id),
        ),
      ),
    );

    // The same price, raised as a quote in Jobber. After the response on
    // purpose: the customer already has the text, and Jobber being slow or
    // down must not make the office think the quote didn't go out.
    void queueQuotePush(company, updated!).catch((err) =>
      logger.error(
        { err, bookingId: updated!.id },
        "Jobber quote push threw after send",
      ),
    );
  },
);

// Owner reviewed a booking after a timezone change and says the displayed
// time is right as-is. Idempotent: confirming an unflagged booking is a no-op.
router.post(
  "/bookings/:id/confirm-time",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = ConfirmBookingTimeParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }
    const [booking] = await db
      .update(bookingsTable)
      .set({ needsTimeReview: false, timeReviewPreviousTimezone: null })
      .where(
        and(
          eq(bookingsTable.id, params.data.id),
          eq(bookingsTable.companyId, company.id),
        ),
      )
      .returning();
    if (!booking) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }
    res.json(
      ConfirmBookingTimeResponse.parse(
        serializeBooking(
          company,
          booking,
          [],
          await timeEntriesFor(company.id, booking.id),
        ),
      ),
    );
  },
);

/**
 * The one place the reschedule text is worded, so the preview the dispatcher
 * edits and the fallback the server sends can never drift apart.
 */
function rescheduleTextDraft(company: Company, booking: Booking): string {
  const when = formatAppointment(booking.scheduledFor, company.timezone);
  return (
    `Hi ${booking.customerName.trim() || "there"}, quick update from ${company.name}: ` +
    `your ${booking.service} is now scheduled for ${when}. ` +
    `Reply here if that doesn't work for you.`
  );
}

// The draft shown in the editable box before "Send text" — same checks as the
// send route so "can't send" surfaces before the dispatcher polishes a
// message that was never going anywhere.
router.get(
  "/bookings/:id/reschedule-text-preview",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = GetRescheduleTextPreviewParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }
    const booking = await loadBooking(company.id, params.data.id);
    if (!booking) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }

    const message = rescheduleTextDraft(company, booking);

    let blockedReason: string | null = null;
    if (!toE164(booking.customerPhone)) {
      blockedReason =
        "This customer's phone number isn't a number we can text.";
    } else if (!companyQuoKey(company)) {
      blockedReason = "Connect your Quo account to text customers.";
    } else {
      const sender = await resolveQuoteSender(company, booking);
      if ("blockedReason" in sender) blockedReason = sender.blockedReason;
    }

    res.json(
      GetRescheduleTextPreviewResponse.parse({
        message,
        canSend: blockedReason === null,
        blockedReason,
      }),
    );
  },
);

// After a reschedule, text the customer the new time so the appointment in
// their head (or an earlier quote text) doesn't win over the one on file.
router.post(
  "/bookings/:id/send-reschedule-text",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = SendRescheduleTextParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    // Optional body: an edited draft from the preview box. No body (older
    // callers) or no message means "send the server's own draft".
    const body = SendRescheduleTextBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }
    const booking = await loadBooking(company.id, params.data.id);
    if (!booking) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }

    const to = toE164(booking.customerPhone);
    if (!to) {
      res.status(400).json({
        error: "This customer's phone number isn't a number we can text.",
      });
      return;
    }
    // Same sender resolution as quote texting so the customer sees the whole
    // conversation on one thread.
    const sender = await resolveQuoteSender(company, booking);
    if ("blockedReason" in sender) {
      res.status(409).json({ error: sender.blockedReason });
      return;
    }
    const apiKey = companyQuoKey(company);
    if (!apiKey) {
      res
        .status(409)
        .json({ error: "Connect your Quo account to text customers." });
      return;
    }

    // The dispatcher's edited copy wins; otherwise the server's own draft
    // (always the company zone — the same hour the dispatcher just saved).
    const edited = body.data.message?.trim();
    const content = edited || rescheduleTextDraft(company, booking);
    const when = formatAppointment(booking.scheduledFor, company.timezone);

    try {
      await sendMessage(apiKey, { from: sender.from, to, content });
    } catch (err) {
      logger.error({ err }, "Reschedule text failed to send");
      res.status(502).json({
        error:
          err instanceof Error
            ? `Couldn't send the text: ${err.message}`
            : "Couldn't send the text",
      });
      return;
    }

    // The customer already has the text; a bookkeeping failure here must not
    // read as "not sent" or the dispatcher will text them twice.
    try {
      await db.insert(activityTable).values({
        companyId: company.id,
        type: "reschedule_texted",
        message: `New time texted to ${customerLabel(booking)}: ${when}.`,
      });
    } catch (err) {
      logger.error(
        { err, bookingId: booking.id, companyId: company.id },
        "Reschedule text was delivered but recording it failed",
      );
    }

    res.json(
      SendRescheduleTextResponse.parse(
        serializeBooking(
          company,
          booking,
          [],
          await timeEntriesFor(company.id, booking.id),
        ),
      ),
    );
  },
);

router.post(
  "/bookings/:id/sync-jobber",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = SyncBookingToJobberParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }
    let [existing] = await db
      .select()
      .from(bookingsTable)
      .where(
        and(
          eq(bookingsTable.id, params.data.id),
          eq(bookingsTable.companyId, company.id),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }
    const blockedReason = bookingJobberManualSyncBlockedReason(
      company,
      existing,
    );
    if (blockedReason) {
      res.status(409).json({ error: blockedReason });
      return;
    }

    // Bookings push themselves as they are created, so this button is the
    // retry: it either finishes a push that failed, or reports that Jobber
    // already has it.
    const result = await queueBookingJobberSync(company, existing);
    if (result.status === "failed") {
      res.status(502).json({ error: `Jobber sync failed: ${result.error}` });
      return;
    }

    res.json(
      SyncBookingToJobberResponse.parse(
        serializeBooking(
          company,
          result.booking,
          [],
          await timeEntriesFor(company.id, result.booking.id),
        ),
      ),
    );
  },
);

// A booking being invoiced holds a claim marker (never a real Jobber id) in
// jobber_invoice_id until the invoice exists. Claims older than this are
// treated as abandoned (a crashed request) and may be retried.
const INVOICE_CLAIM_PREFIX = "pending:";
const INVOICE_CLAIM_STALE_MS = 10 * 60 * 1000;

/**
 * Create a Jobber invoice from the booking's quote. The web app calls this
 * when the office clicks Create Invoice — and when a job is marked
 * completed, so the invoice is ready to send the moment the crew finishes.
 * Idempotent either way: a booking that already has a real invoice returns
 * that same invoice, never a duplicate. The invoice is built
 * from the same derived line items the customer's quote used (or the flat
 * quoted amount), with a credit line for any deposit already collected, and
 * lands in Jobber unsent so the office reviews it there. Tax is deliberately
 * left to Jobber's own settings — sending ours as a line item would tax it
 * twice. The connected account must therefore be configured with the app's
 * fixed 12.5% tax before this endpoint is used.
 */
router.post(
  "/bookings/:id/invoice",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = CreateBookingInvoiceParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }
    if (company.jobberNeedsReauth) {
      res.status(409).json({
        error:
          "Jobber authorization has expired — reconnect Jobber to keep syncing.",
      });
      return;
    }
    if (!company.jobberConnected || !company.jobberRefreshToken) {
      res
        .status(400)
        .json({ error: "Connect Jobber before creating invoices" });
      return;
    }

    const [existing] = await db
      .select()
      .from(bookingsTable)
      .where(
        and(
          eq(bookingsTable.id, params.data.id),
          eq(bookingsTable.companyId, company.id),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }
    // Already invoiced: return the booking as-is. Two clicks (or two
    // dispatchers) must not produce two invoices for the same job.
    if (
      existing.jobberInvoiceId &&
      !existing.jobberInvoiceId.startsWith(INVOICE_CLAIM_PREFIX)
    ) {
      res.json(
        CreateBookingInvoiceResponse.parse(
          serializeBooking(
            company,
            existing,
            [],
            await timeEntriesFor(company.id, existing.id),
          ),
        ),
      );
      return;
    }
    if (!existing.jobberClientId) {
      res.status(400).json({
        error:
          "Sync this booking to Jobber first — the invoice needs a Jobber client to bill.",
      });
      return;
    }

    const totals = computeQuoteTotals(company, existing);
    if ((existing.depositPaidAmount ?? 0) > 0) {
      // A negative invoice line is not safe here: Jobber may tax that credit,
      // reducing the tax collected and making the balance disagree with the
      // customer quote. Until the Jobber payment/credit mutation is verified,
      // stop before claiming or creating anything and make the mismatch clear.
      res.status(409).json({
        error:
          "This booking has a paid deposit. Create its Jobber invoice manually so the deposit is applied after tax; automatic invoice creation is paused to prevent an incorrect balance.",
      });
      return;
    }
    const lineItems =
      totals.lineItems.length > 0
        ? totals.lineItems.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
          }))
        : [
            {
              // Blank until the caller says what they want, but an invoice
              // line with no name is not something to send a customer.
              name: serviceLabel(existing),
              quantity: 1,
              unitPrice: totals.subtotal,
            },
          ];
    // Never send the calculated tax as an invoice line. Jobber's configured
    // 12.5% account tax is the one tax treatment; an explicit tax line would
    // be taxable itself and charge the customer twice.
    if ((existing.depositPaidAmount ?? 0) > 0) {
      lineItems.push({
        name: "Deposit paid",
        quantity: 1,
        unitPrice: -existing.depositPaidAmount!,
      });
    }
    // A zero-value invoice helps nobody and usually means the quote was never
    // priced; make the office price the job first.
    if (lineItems.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0) <= 0) {
      res.status(400).json({
        error:
          "This booking has no priced quote yet — set a price before invoicing.",
      });
      return;
    }

    // Claim the booking BEFORE calling Jobber. Two dispatchers clicking at
    // once must not both reach invoiceCreate — that would leave a duplicate
    // invoice in Jobber that nothing tracks. The claim is a conditional
    // update: only one request wins; the loser is told it's in progress.
    // A claim abandoned by a crash is re-claimable after it goes stale.
    const claim = `${INVOICE_CLAIM_PREFIX}${Date.now()}`;
    const staleBefore = Date.now() - INVOICE_CLAIM_STALE_MS;
    const claimedRows = await db
      .update(bookingsTable)
      .set({ jobberInvoiceId: claim })
      .where(
        and(
          eq(bookingsTable.id, existing.id),
          existing.jobberInvoiceId === null
            ? isNull(bookingsTable.jobberInvoiceId)
            : eq(bookingsTable.jobberInvoiceId, existing.jobberInvoiceId),
        ),
      )
      .returning({ id: bookingsTable.id });
    const priorClaimAge = existing.jobberInvoiceId?.startsWith(
      INVOICE_CLAIM_PREFIX,
    )
      ? Number(existing.jobberInvoiceId.slice(INVOICE_CLAIM_PREFIX.length))
      : null;
    if (claimedRows.length === 0) {
      res.status(409).json({
        error: "An invoice is already being created for this booking.",
      });
      return;
    }
    if (priorClaimAge !== null && priorClaimAge > staleBefore) {
      // We re-claimed over a live claim only because the conditional matched
      // the exact same marker we read — meaning nothing else touched it, but
      // the original attempt may still be in flight. Back off.
      await db
        .update(bookingsTable)
        .set({ jobberInvoiceId: existing.jobberInvoiceId })
        .where(
          and(
            eq(bookingsTable.id, existing.id),
            eq(bookingsTable.jobberInvoiceId, claim),
          ),
        );
      res.status(409).json({
        error: "An invoice is already being created for this booking.",
      });
      return;
    }

    try {
      const accessToken = await getValidAccessToken(company);
      await verifyJobberTaxConfiguration(accessToken);
      const scheduled = existing.scheduledFor.toLocaleDateString("en-US", {
        dateStyle: "long",
        timeZone: company.timezone,
      });
      const invoice = await createJobberInvoice(accessToken, {
        clientId: existing.jobberClientId,
        subject: `${serviceLabel(existing)} — ${scheduled}`,
        lineItems,
      });
      // Best effort — a missing link only costs the office a click through
      // the job page, and must never fail an invoice Jobber already made.
      const invoiceWebUri = await getJobberInvoiceWebUri(
        accessToken,
        invoice.id,
      );

      const [booking] = await db
        .update(bookingsTable)
        .set({
          jobberInvoiceId: invoice.id,
          jobberInvoiceNumber: invoice.invoiceNumber,
          jobberInvoiceWebUri: invoiceWebUri,
        })
        .where(eq(bookingsTable.id, existing.id))
        .returning();

      await db.insert(activityTable).values({
        companyId: company.id,
        type: "jobber_synced",
        message: `Invoice${invoice.invoiceNumber ? ` #${invoice.invoiceNumber}` : ""} created in Jobber for ${customerLabel(existing)}'s ${existing.service.toLowerCase()}.`,
      });

      res.json(
        CreateBookingInvoiceResponse.parse(
          serializeBooking(
            company,
            booking!,
            [],
            await timeEntriesFor(company.id, booking!.id),
          ),
        ),
      );
    } catch (err) {
      logger.error({ err }, "Jobber invoice creation failed");
      // Release the claim so the office can retry — but only if it is still
      // ours; a stale-claim takeover may have moved on without us.
      try {
        await db
          .update(bookingsTable)
          .set({ jobberInvoiceId: null })
          .where(
            and(
              eq(bookingsTable.id, existing.id),
              eq(bookingsTable.jobberInvoiceId, claim),
            ),
          );
      } catch (releaseErr) {
        logger.error(
          { err: releaseErr },
          "Failed to release invoice-creation claim",
        );
      }
      res.status(err instanceof JobberTaxConfigurationError ? 409 : 502).json({
        error:
          err instanceof Error
            ? `Could not create the Jobber invoice: ${err.message}`
            : "Could not create the Jobber invoice",
      });
    }
  },
);

/**
 * The client said yes.
 *
 * With `schedule: false`, the office records a client's yes locally without
 * contacting Jobber. With `schedule: true`, an approval must already exist
 * locally, through the public quote link, or in the mirrored Jobber status;
 * scheduling never changes that provenance.
 */
router.post(
  "/bookings/:id/approve",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = ApproveBookingParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = ApproveBookingBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const caller = await getCaller(req);
    const company = caller.company;
    if (!company) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }
    const booking = await loadBooking(company.id, params.data.id);
    if (!booking) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }
    if (booking.status === "canceled") {
      res.status(400).json({
        error: "This booking was cancelled — reopen it before approving.",
      });
      return;
    }
    const jobberQuoteStatus = booking.jobberQuoteId
      ? ((await loadJobberQuoteStatuses(company.id, [booking])).get(
          booking.jobberQuoteId,
        ) ?? null)
      : null;
    if (parsed.data.schedule) {
      const approvalExists = Boolean(
        booking.clientApprovedAt ||
        booking.quoteApprovedAt ||
        jobberApprovalObserved(jobberQuoteStatus),
      );
      if (!approvalExists) {
        res.status(400).json({
          error:
            "Record the client's approval before scheduling this job in Jobber.",
        });
        return;
      }
      if (booking.status === "completed") {
        res.status(400).json({
          error: "This booking is already completed and cannot be scheduled.",
        });
        return;
      }
      // A stored real job id means scheduling already succeeded. Replays are
      // idempotent even if Jobber was disconnected afterwards.
      if (!scheduledJobberJobId(booking)) {
        const blocked = scheduleBlockedReason(company, booking);
        if (blocked) {
          res.status(400).json({ error: blocked });
          return;
        }
      }
    }

    // Who to credit. An owner's login often carries no name of its own, so
    // fall back to their seat the same way staff chat does — "recorded by"
    // is worthless if it usually says nobody.
    const seat = await resolveChatSeat(company, caller);
    const result = await approveBooking(company, booking, {
      schedule: parsed.data.schedule,
      recordedBy: caller.name || seat?.name || null,
      approvalObservedInJobber: jobberApprovalObserved(jobberQuoteStatus),
    });

    const crews = await loadCrews([result.booking.id]);
    res.json(
      ApproveBookingResponse.parse({
        booking: serializeBooking(
          company,
          result.booking,
          crews.get(result.booking.id) ?? [],
          await timeEntriesFor(company.id, result.booking.id),
          jobberQuoteStatus,
        ),
        recorded: result.recorded,
        scheduledInJobber: result.scheduledInJobber,
        unmatchedCrew: result.unmatchedCrew,
        jobberError: result.jobberError,
      }),
    );
  },
);

/**
 * The on-site clock.
 *
 * Crew tap Start when they walk in and Stop when they leave, and the office
 * bills from the total. Deliberately open to cleaners — they are the ones at
 * the house — but a cleaner may only clock a job they were actually sent to,
 * the same rule the rest of their access follows.
 */
type TimerTarget =
  | { ok: true; company: Company; booking: Booking; actor: CrewClockIdentity }
  | { ok: false; status: number; error: string };

type CrewClockIdentity = { teamMemberId: number | null; name: string | null };

async function resolveTimerTarget(
  req: Parameters<typeof getCaller>[0],
  bookingId: number,
): Promise<TimerTarget> {
  const caller = await getCaller(req);
  if (!caller.company) {
    return { ok: false, status: 404, error: "Booking not found" };
  }
  const company = caller.company;

  const [booking] = await db
    .select()
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.id, bookingId),
        eq(bookingsTable.companyId, company.id),
      ),
    );
  if (!booking) {
    return { ok: false, status: 404, error: "Booking not found" };
  }

  // A cleaner clocks their own jobs only. Answering 404 rather than 403 keeps
  // the existence of other companies' — and other crews' — jobs private.
  if (caller.role === "cleaner") {
    const [assignment] = await db
      .select({ id: bookingAssignmentsTable.id })
      .from(bookingAssignmentsTable)
      .where(
        and(
          eq(bookingAssignmentsTable.bookingId, booking.id),
          eq(bookingAssignmentsTable.teamMemberId, caller.teamMemberId!),
        ),
      )
      .limit(1);
    if (!assignment) {
      return { ok: false, status: 404, error: "Booking not found" };
    }
  }

  return {
    ok: true,
    company,
    booking,
    actor: {
      teamMemberId: caller.teamMemberId,
      // The office starting a clock on the crew's behalf is recorded under
      // their own name, so the history reads as what actually happened.
      name: caller.name || null,
    },
  };
}

/** The clock time in the company's own zone — never the server's, never the phone's. */
function clockTime(when: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(when);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    }).format(when);
  }
}

async function respondWithTimer(
  res: Response,
  schema: typeof StartBookingTimerResponse | typeof StopBookingTimerResponse,
  company: Company,
  booking: Booking,
  isCleaner: boolean,
): Promise<void> {
  const crews = await loadCrews([booking.id]);
  const serialized = serializeBooking(
    company,
    booking,
    crews.get(booking.id) ?? [],
    await timeEntriesFor(company.id, booking.id),
  );
  res.json(
    schema.parse(isCleaner ? redactBookingForCleaner(serialized) : serialized),
  );
}

router.post("/bookings/:id/timer/start", async (req, res): Promise<void> => {
  const params = StartBookingTimerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const target = await resolveTimerTarget(req, params.data.id);
  if (!target.ok) {
    res.status(target.status).json({ error: target.error });
    return;
  }
  const { company, booking, actor } = target;
  const caller = await getCaller(req);

  const [running] = await db
    .select()
    .from(bookingTimeEntriesTable)
    .where(
      and(
        eq(bookingTimeEntriesTable.companyId, company.id),
        eq(bookingTimeEntriesTable.bookingId, booking.id),
        isNull(bookingTimeEntriesTable.endedAt),
      ),
    )
    .limit(1);

  // Already running: hand back the same job rather than opening a second
  // clock. A cleaner who taps twice because the first tap looked slow must
  // not end up billing the customer for two overlapping stretches.
  if (!running) {
    const startedAt = new Date();
    let opened = false;
    try {
      await db.insert(bookingTimeEntriesTable).values({
        companyId: company.id,
        bookingId: booking.id,
        teamMemberId: actor.teamMemberId,
        startedByName: actor.name,
        startedAt,
      });
      opened = true;
    } catch (err) {
      // The partial unique index caught a genuine double tap racing itself.
      // That is the outcome we wanted, so report the running clock, not a 500.
      const [now] = await db
        .select()
        .from(bookingTimeEntriesTable)
        .where(
          and(
            eq(bookingTimeEntriesTable.companyId, company.id),
            eq(bookingTimeEntriesTable.bookingId, booking.id),
            isNull(bookingTimeEntriesTable.endedAt),
          ),
        )
        .limit(1);
      if (!now) throw err;
    }

    // Only the tap that actually opened the clock goes in the feed — the one
    // that lost the race started nothing, and the office should not read two
    // starts for one arrival.
    if (opened) {
      await db.insert(activityTable).values({
        companyId: company.id,
        type: "job_started",
        message: `${actor.name || "Crew"} started ${customerLabel(booking)}'s job at ${clockTime(startedAt, company.timezone)}.`,
        bookingId: booking.id,
      });
    }
  }

  await respondWithTimer(
    res,
    StartBookingTimerResponse,
    company,
    booking,
    caller.role === "cleaner",
  );
});

router.post("/bookings/:id/timer/stop", async (req, res): Promise<void> => {
  const params = StopBookingTimerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const target = await resolveTimerTarget(req, params.data.id);
  if (!target.ok) {
    res.status(target.status).json({ error: target.error });
    return;
  }
  const { company, booking, actor } = target;
  const caller = await getCaller(req);

  const endedAt = new Date();
  // Conditional on the clock still being open, so two devices stopping the
  // same job at once close it once and only the winner records the time.
  const [stopped] = await db
    .update(bookingTimeEntriesTable)
    .set({ endedAt })
    .where(
      and(
        eq(bookingTimeEntriesTable.companyId, company.id),
        eq(bookingTimeEntriesTable.bookingId, booking.id),
        isNull(bookingTimeEntriesTable.endedAt),
      ),
    )
    .returning();

  if (!stopped) {
    res.status(409).json({ error: "The clock isn't running on this job" });
    return;
  }

  const minutes = entryMinutes(stopped);
  const total = summarizeTimeEntries(
    await timeEntriesFor(company.id, booking.id),
  );
  await db.insert(activityTable).values({
    companyId: company.id,
    type: "job_finished",
    message: `${actor.name || "Crew"} finished ${customerLabel(booking)}'s job at ${clockTime(endedAt, company.timezone)} — ${formatWorkedTime(minutes)} on site (${formatWorkedTime(total.workedMinutes)} total).`,
    bookingId: booking.id,
  });

  await pushTimeToJobber(company, booking, stopped, {
    startedAt: stopped.startedAt,
    endedAt,
    minutes,
    who: stopped.startedByName,
  });

  await respondWithTimer(
    res,
    StopBookingTimerResponse,
    company,
    booking,
    caller.role === "cleaner",
  );
});

/**
 * Write the finished stretch onto the Jobber job.
 *
 * Jobber's API exposes time sheet entries for reading only, so the hours go on
 * as a note — the office sees them where they build the invoice. Best effort
 * by design: the clock belongs to this app, and a Jobber outage must never
 * stop a cleaner from clocking off. The note id is stored so a later retry
 * cannot post the same stretch twice.
 */
async function pushTimeToJobber(
  company: Company,
  booking: Booking,
  entry: BookingTimeEntry,
  worked: {
    startedAt: Date;
    endedAt: Date;
    minutes: number;
    who: string | null;
  },
): Promise<void> {
  if (!company.jobberConnected || company.jobberNeedsReauth) return;
  // Already posted once. Nothing here is worth telling the customer's file twice.
  if (entry.jobberNoteId) return;
  // This stretch came *from* Jobber's own timer. Sending it back would have
  // the same hour sitting in their file twice, once as a timer and once as
  // our note.
  if (entry.jobberTimeEntryId) return;
  // Jobs we imported from their calendar take a job note; bookings we pushed
  // out exist in Jobber as a work request, which takes a request note.
  const jobId = booking.jobberSyncedJobId;
  const requestId = jobId ? null : booking.jobberJobId;
  if (!jobId && !requestId) return;

  const window = `${clockTime(worked.startedAt, company.timezone)} – ${clockTime(worked.endedAt, company.timezone)}`;
  const message = [
    `Time on site: ${formatWorkedTime(worked.minutes)} (${window})`,
    worked.who ? `Clocked by ${worked.who}` : null,
    "Recorded by Book My Cleaning.",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const accessToken = await getValidAccessToken(company);
    // The request-note path is a boolean helper, so mark it with the request
    // it landed on — enough to know the note exists and never repost it.
    const noteId = jobId
      ? (await createJobberJobNote(accessToken, jobId, message)).id
      : (await tryAttachRequestNote(accessToken, requestId!, message))
        ? `request:${requestId}`
        : "";
    if (!noteId) throw new Error("Jobber would not accept the note");
    await db
      .update(bookingTimeEntriesTable)
      .set({ jobberNoteId: noteId, jobberSyncError: null })
      .where(
        and(
          eq(bookingTimeEntriesTable.id, entry.id),
          eq(bookingTimeEntriesTable.companyId, company.id),
        ),
      );
  } catch (err) {
    const failure = err instanceof Error ? err.message : "Unknown error";
    logger.warn(
      { err, bookingId: booking.id, companyId: company.id },
      "Could not write clocked time to Jobber",
    );
    await db
      .update(bookingTimeEntriesTable)
      .set({ jobberSyncError: failure })
      .where(
        and(
          eq(bookingTimeEntriesTable.id, entry.id),
          eq(bookingTimeEntriesTable.companyId, company.id),
        ),
      );
  }
}

export default router;
