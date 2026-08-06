import { Router, type IRouter } from "express";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import {
  db,
  bookingsTable,
  bookingAssignmentsTable,
  teamMembersTable,
  servicesTable,
  callsTable,
  activityTable,
  type Booking,
} from "@workspace/db";
import {
  ListBookingsResponse,
  ListBookingsInRangeQueryParams,
  ListBookingsInRangeResponse,
  CreateBookingBody,
  CreateBookingResponse,
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
  SendRescheduleTextResponse,
  SetBookingCrewParams,
  SetBookingCrewBody,
  SetBookingCrewResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireRole } from "../middlewares/requireRole";
import { getCompanyForUser, companyQuoKey } from "../lib/company";
import { companyDayBounds } from "../lib/dayBounds";
import { getCaller } from "../middlewares/requireRole";
import { listPhoneNumbers, sendMessage, toE164 } from "../lib/quo";
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
  createJobberClient,
  createJobberRequest,
  tryAttachRequestNote,
} from "../lib/jobber";
import { logger } from "../lib/logger";
import { redactBookingForCleaner } from "../lib/bookingVisibility";

const router: IRouter = Router();

router.use(requireAuth);

type CrewMember = { id: number; name: string; role: string };

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
    })
    .from(bookingAssignmentsTable)
    .innerJoin(
      teamMembersTable,
      eq(bookingAssignmentsTable.teamMemberId, teamMembersTable.id),
    )
    .where(inArray(bookingAssignmentsTable.bookingId, bookingIds))
    .orderBy(teamMembersTable.name);

  for (const row of rows) {
    const list = crews.get(row.bookingId) ?? [];
    list.push({ id: row.id, name: row.name, role: row.role });
    crews.set(row.bookingId, list);
  }
  return crews;
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

/**
 * The address as a human would write it, from the separate boxes the booking
 * desk types into. Bookings taken before those boxes existed keep the whole
 * address in `customerAddress`, so this returns that unchanged for them.
 */
export function joinAddress(b: {
  customerAddress: string | null;
  addressCity: string | null;
  addressProvince: string | null;
  addressPostal: string | null;
}): string | null {
  const cityLine = [b.addressCity, b.addressProvince]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(", ");
  const joined = [b.customerAddress?.trim(), cityLine, b.addressPostal?.trim()]
    .filter(Boolean)
    .join(", ");
  return joined || null;
}

const FREQUENCY_LABELS: Record<string, string> = {
  one_time: "One time",
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
};

/** Falls back to the stored value so an unknown code still reads as something. */
function frequencyLabel(frequency: string): string {
  return FREQUENCY_LABELS[frequency] ?? frequency;
}

function serializeBooking(
  company: Company,
  b: Booking,
  crew: CrewMember[] = [],
) {
  return {
    ...b,
    // Who is working the job. Defaulted rather than required so the many
    // existing call sites that respond with a single booking keep compiling.
    crew,
    scheduledFor: b.scheduledFor.toISOString(),
    // Nullable: only set once a quote has actually gone out. Forgetting this
    // breaks every booking response, not just the one that was quoted.
    quoteSentAt: b.quoteSentAt ? b.quoteSentAt.toISOString() : null,
    jobberSyncErrorAt: b.jobberSyncErrorAt
      ? b.jobberSyncErrorAt.toISOString()
      : null,
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
        customerName: r.customerName,
        service: r.service,
        scheduledFor: r.scheduledFor.toISOString(),
        durationMinutes:
          r.durationMinutes ??
          serviceDuration.get(r.service) ??
          DEFAULT_DURATION_MINUTES,
        status: r.status,
        located: r.lat !== null && r.lng !== null,
        assignees: (crews.get(r.id) ?? []).map((c) => ({
          teamMemberId: c.id,
          name: c.name,
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

  // A cleaner sees only the jobs they are actually on — the whole point of
  // the role. Filtered in SQL rather than after the fact so an unassigned
  // job never reaches their device.
  const scope =
    caller.role === "cleaner" && caller.teamMemberId !== null
      ? and(
          eq(bookingsTable.companyId, company.id),
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
      : eq(bookingsTable.companyId, company.id);

  const bookings = await db
    .select()
    .from(bookingsTable)
    .where(scope)
    .orderBy(desc(bookingsTable.createdAt));

  const crews = await loadCrews(bookings.map((b) => b.id));

  // Pricing and Jobber state never leave the server for a crew login —
  // hidden UI on the phone is not a boundary; this is.
  const serialized = bookings.map((b) => {
    const s = serializeBooking(company, b, crews.get(b.id) ?? []);
    return caller.role === "cleaner" ? redactBookingForCleaner(s) : s;
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
          ? `${eligible.map((m) => m.name).join(", ")} assigned to ${booking.customerName}'s job.`
          : `Crew cleared from ${booking.customerName}'s job.`,
    });

    const crews = await loadCrews([booking.id]);
    res.json(
      SetBookingCrewResponse.parse(
        serializeBooking(company, booking, crews.get(booking.id) ?? []),
      ),
    );
  },
);

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

  const [booking] = await db
    .update(bookingsTable)
    .set(updates)
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
  const serialized = serializeBooking(company, booking);
  res.json(
    UpdateBookingResponse.parse(
      caller.role === "cleaner"
        ? redactBookingForCleaner(serialized)
        : serialized,
    ),
  );
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

    // Checked before the insert, so a bad crew id doesn't leave a saved
    // booking behind with an error message on top of it — the dispatcher is
    // still on the phone and would have no idea it half-worked.
    const requestedCrew = [...new Set(parsed.data.teamMemberIds ?? [])];
    const eligible = await eligibleCrew(company.id, requestedCrew);
    if (eligible.length !== requestedCrew.length) {
      res.status(400).json({
        error: "One or more people are not on your team, or are off the roster",
      });
      return;
    }

    // One transaction for the booking, its crew and the activity lines. The
    // dispatcher is on the phone: an error message must mean "nothing was
    // saved", never "saved, but nobody is assigned to it".
    const booking = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(bookingsTable)
        .values({
          companyId: company.id,
          // Hand-entered bookings have no originating call.
          callId: null,
          customerName: parsed.data.customerName,
          customerPhone: parsed.data.customerPhone,
          customerEmail: parsed.data.customerEmail ?? null,
          customerAddress: parsed.data.customerAddress ?? null,
          addressCity: parsed.data.addressCity ?? null,
          addressProvince: parsed.data.addressProvince ?? null,
          addressPostal: parsed.data.addressPostal ?? null,
          service: parsed.data.service,
          bedrooms: parsed.data.bedrooms ?? null,
          bathrooms: parsed.data.bathrooms ?? null,
          extras: parsed.data.extras ?? null,
          frequency: parsed.data.frequency ?? null,
          internalNotes: parsed.data.internalNotes ?? null,
          scheduledFor: when,
          status: parsed.data.status ?? "pending",
          quoteHours: parsed.data.quoteHours ?? null,
          quoteCrewLabel: parsed.data.quoteCrewLabel ?? null,
          quoteHourlyRate: parsed.data.quoteHourlyRate ?? null,
          quoteFuelSurcharge: parsed.data.quoteFuelSurcharge ?? null,
          quoteDiscountAmount: parsed.data.quoteDiscountAmount ?? null,
          quoteReferralSource: parsed.data.quoteReferralSource ?? null,
          quotedAmount: parsed.data.quotedAmount ?? null,
          quoteDeposit: parsed.data.quoteDeposit ?? null,
          quoteNotes: parsed.data.quoteNotes ?? null,
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

      const activity = [
        {
          companyId: company.id,
          type: "booking_created",
          message: `Booking added by hand for ${row!.customerName} — ${row!.service}.`,
        },
      ];
      if (eligible.length > 0) {
        activity.push({
          companyId: company.id,
          type: "crew_assigned",
          message: `${eligible.map((m) => m.name).join(", ")} assigned to ${row!.customerName}'s job.`,
        });
      }
      await tx.insert(activityTable).values(activity);

      return row!;
    });

    res
      .status(201)
      .json(CreateBookingResponse.parse(serializeBooking(company, booking)));
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
        message: `Quote texted to ${booking.customerName} at ${booking.customerPhone}.`,
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

    res.json(SendQuoteResponse.parse(serializeBooking(company, updated!)));
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
      ConfirmBookingTimeResponse.parse(serializeBooking(company, booking)),
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

    // Always the company zone — the same hour the dispatcher just saved.
    const when = formatAppointment(booking.scheduledFor, company.timezone);
    const content =
      `Hi ${booking.customerName.trim() || "there"}, quick update from ${company.name}: ` +
      `your ${booking.service} is now scheduled for ${when}. ` +
      `Reply here if that doesn't work for you.`;

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
        message: `New time texted to ${booking.customerName}: ${when}.`,
      });
    } catch (err) {
      logger.error(
        { err, bookingId: booking.id, companyId: company.id },
        "Reschedule text was delivered but recording it failed",
      );
    }

    res.json(
      SendRescheduleTextResponse.parse(serializeBooking(company, booking)),
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
    if (company.jobberNeedsReauth) {
      res.status(409).json({
        error:
          "Jobber authorization has expired — reconnect Jobber to keep syncing.",
      });
      return;
    }
    if (!company.jobberConnected || !company.jobberRefreshToken) {
      res.status(400).json({ error: "Connect Jobber before syncing bookings" });
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
    if (existing.jobberSynced) {
      res.json(
        SyncBookingToJobberResponse.parse(serializeBooking(company, existing)),
      );
      return;
    }

    // Wizard answers extracted from the call, mapped into the Jobber request note
    let extractedAnswers: Array<{ field: string; value: string }> = [];
    if (existing.callId) {
      const [call] = await db
        .select()
        .from(callsTable)
        // Scoped to the company as well as the id. A booking should only ever
        // point at its own company's call, but this note is sent outside the
        // system, so it is not the place to take that on trust.
        .where(
          and(
            eq(callsTable.id, existing.callId),
            eq(callsTable.companyId, company.id),
          ),
        );
      extractedAnswers =
        (call?.extractedAnswers as typeof extractedAnswers) ?? [];
    }

    try {
      const accessToken = await getValidAccessToken(company);
      const client = await createJobberClient(accessToken, {
        name: existing.customerName,
        phone: existing.customerPhone,
      });
      // In the company's own timezone, not the server's — otherwise the time
      // in Jobber is a different hour from the one the dispatcher picked and
      // the one the customer was told.
      const scheduled = existing.scheduledFor.toLocaleString("en-US", {
        dateStyle: "full",
        timeStyle: "short",
        timeZone: company.timezone,
      });
      // Jobber gets the whole address on one line — the separate city and
      // postal boxes on the booking desk are for the person typing, not for
      // Jobber, which takes a single string.
      const fullAddress = joinAddress(existing);
      const request = await createJobberRequest(accessToken, {
        clientId: client.id,
        title: `${existing.service} — ${existing.customerName} (requested ${scheduled})`,
        address: fullAddress,
      });

      const scope = [
        existing.bedrooms != null ? `${existing.bedrooms} bed` : null,
        existing.bathrooms != null ? `${existing.bathrooms} bath` : null,
      ].filter(Boolean);

      const noteLines = [
        `Booking captured by the Book My Cleaning AI receptionist.`,
        `Service: ${existing.service}`,
        `Requested time: ${scheduled}`,
        `Phone: ${existing.customerPhone}`,
        ...(existing.customerEmail ? [`Email: ${existing.customerEmail}`] : []),
        ...(fullAddress ? [`Address: ${fullAddress}`] : []),
        ...(scope.length > 0 ? [`Home: ${scope.join(", ")}`] : []),
        ...(existing.extras && existing.extras.length > 0
          ? [`Extras: ${existing.extras.join(", ")}`]
          : []),
        ...(existing.frequency && existing.frequency !== "one_time"
          ? [`Frequency: ${frequencyLabel(existing.frequency)}`]
          : []),
        ...(existing.internalNotes
          ? [`Entry notes: ${existing.internalNotes}`]
          : []),
        ...extractedAnswers.map((a) => `${a.field}: ${a.value}`),
      ];
      await tryAttachRequestNote(accessToken, request.id, noteLines.join("\n"));

      const [booking] = await db
        .update(bookingsTable)
        .set({
          jobberSynced: true,
          jobberJobId: request.id,
          jobberClientId: client.id,
          jobberWebUri: request.jobberWebUri,
          jobberSyncError: null,
          jobberSyncErrorAt: null,
        })
        .where(eq(bookingsTable.id, existing.id))
        .returning();

      await db.insert(activityTable).values({
        companyId: company.id,
        type: "jobber_synced",
        message: `Booking for ${booking!.customerName} synced to Jobber as a work request.`,
      });

      res.json(
        SyncBookingToJobberResponse.parse(serializeBooking(company, booking!)),
      );
    } catch (err) {
      logger.error({ err }, "Jobber sync failed");
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      try {
        await db
          .update(bookingsTable)
          .set({ jobberSyncError: errorMessage, jobberSyncErrorAt: new Date() })
          .where(eq(bookingsTable.id, existing.id));
        await db.insert(activityTable).values({
          companyId: company.id,
          type: "jobber_sync_failed",
          message: `Jobber sync failed for ${existing.customerName}'s booking: ${errorMessage}`,
        });
      } catch (recordErr) {
        logger.error(
          { err: recordErr },
          "Failed to record Jobber sync failure",
        );
      }
      res.status(502).json({
        error:
          err instanceof Error
            ? `Jobber sync failed: ${err.message}`
            : "Jobber sync failed",
      });
    }
  },
);

export default router;
