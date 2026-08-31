/**
 * Pushing our own work into Jobber: the customer, the address, the work
 * request, and the quote.
 *
 * This is the outbound half of the Jobber integration (the inbound half lives
 * in jobberCalendarSync.ts). Every booking the company takes — typed in at the
 * desk, captured off a phone call by the AI receptionist, or texted in — is
 * meant to appear in Jobber without anyone re-typing it.
 *
 * Three rules hold this together:
 *
 *   - Never push back what Jobber gave us. A booking carrying `jobberVisitId`
 *     or `jobberSyncedJobId` was imported; sending it over would clone the
 *     owner's own job.
 *   - One push at a time per booking. The push is claimed with a marker in
 *     `jobber_job_id` before any Jobber call, so an automatic push racing the
 *     office clicking "Send to Jobber" cannot create two requests for one job.
 *   - Remember the customer the moment Jobber gives us one. The client id is
 *     stored before the request is attempted, so a failure half way through
 *     leaves a client we can find again instead of an orphan — and the retry
 *     reuses it rather than minting a duplicate.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  bookingsTable,
  bookingAssignmentsTable,
  teamMembersTable,
  activityTable,
  callsTable,
  leadsTable,
  jobberConnectionsTable,
  type Booking,
  type Company,
} from "@workspace/db";
import {
  getValidAccessToken,
  getValidConnectionToken,
  findJobberClient,
  createJobberClient,
  ensureJobberProperty,
  updateJobberProperty,
  createJobberRequest,
  createJobberQuote,
  updateJobberQuote,
  tryAttachRequestNote,
  type JobberAddress,
  type JobberProperty,
} from "../lib/jobber";
import {
  joinAddress,
  frequencyLabel,
  customerLabel,
} from "../lib/bookingFormat";
import { recordClientContact } from "./clientDirectory";
import { computeQuoteTotals } from "../lib/quotes";
import { logger } from "../lib/logger";

/** A claim marker, never a real Jobber id — those come back opaque from Jobber. */
export const PUSH_CLAIM_PREFIX = "pending:";
/** A claim older than this belonged to a crashed attempt and may be retaken. */
export const PUSH_CLAIM_STALE_MS = 5 * 60 * 1000;
export const JOBBER_CLIENT_SYNC_ERROR_PREFIX =
  "Updating the Jobber customer failed: ";
export const OTHER_JOBBER_ERROR_SEPARATOR =
  "\nAnother Jobber sync problem is still pending: ";

export function isJobberClientSyncError(error: string | null): boolean {
  return Boolean(error?.startsWith(JOBBER_CLIENT_SYNC_ERROR_PREFIX));
}

export function otherJobberError(error: string | null): string | null {
  if (!error) return null;
  if (!isJobberClientSyncError(error)) return error;
  const separator = error.indexOf(OTHER_JOBBER_ERROR_SEPARATOR);
  return separator === -1
    ? null
    : error.slice(separator + OTHER_JOBBER_ERROR_SEPARATOR.length);
}

/**
 * Fields for a successful non-contact Jobber operation.
 *
 * Quote, request and visit successes may clear their own failure, but a
 * pending customer-contact correction must remain visible and retryable.
 * The SQL expression makes that decision against the row's current value so
 * a concurrent contact failure cannot be erased by a stale success snapshot.
 */
export function nonContactJobberSuccessFields() {
  const contactPattern = `${JOBBER_CLIENT_SYNC_ERROR_PREFIX}%`;
  return {
    jobberSyncError: sql<string | null>`case
      when ${bookingsTable.jobberSyncError} like ${contactPattern}
        and position(${OTHER_JOBBER_ERROR_SEPARATOR} in ${bookingsTable.jobberSyncError}) > 0
        then substring(
          ${bookingsTable.jobberSyncError}
          from 1
          for position(${OTHER_JOBBER_ERROR_SEPARATOR} in ${bookingsTable.jobberSyncError}) - 1
        )
      when ${bookingsTable.jobberSyncError} like ${contactPattern}
        then ${bookingsTable.jobberSyncError}
      else null
    end`,
    jobberSyncErrorAt: sql<Date | null>`case
      when ${bookingsTable.jobberSyncError} like ${contactPattern}
        then ${bookingsTable.jobberSyncErrorAt}
      else null
    end`,
    jobberSyncAttempts: 0,
  };
}

export async function clearNonContactJobberFailure(
  booking: Booking,
): Promise<Booking> {
  if (!booking.jobberSyncError) return booking;
  const [cleared] = await db
    .update(bookingsTable)
    .set(nonContactJobberSuccessFields())
    .where(eq(bookingsTable.id, booking.id))
    .returning();
  return cleared ?? booking;
}

export type JobberPushResult =
  | { status: "synced"; booking: Booking }
  | { status: "skipped"; reason: string; booking: Booking }
  | { status: "failed"; error: string; booking: Booking };

export function isClaim(value: string | null): boolean {
  return Boolean(value?.startsWith(PUSH_CLAIM_PREFIX));
}

export function claimAge(value: string | null): number | null {
  if (!isClaim(value)) return null;
  const at = Number(value!.slice(PUSH_CLAIM_PREFIX.length));
  return Number.isFinite(at) ? at : null;
}

/** The booking's Jobber quote id once it is a real one rather than a claim. */
function realQuoteId(booking: Booking): string | null {
  return booking.jobberQuoteId && !isClaim(booking.jobberQuoteId)
    ? booking.jobberQuoteId
    : null;
}

/**
 * Use the Jobber account that owns this booking's linked objects.
 *
 * Older single-account rows have no connection id and continue through the
 * company credential mirror. New multi-account links always persist their
 * owner so a later quote/contact edit cannot drift to whichever account is
 * primary at that moment.
 */
async function getLinkedBookingAccessToken(
  company: Company,
  booking: Booking,
): Promise<string> {
  if (!booking.jobberConnectionId) return getValidAccessToken(company);
  const [connection] = await db
    .select()
    .from(jobberConnectionsTable)
    .where(
      and(
        eq(jobberConnectionsTable.id, booking.jobberConnectionId),
        eq(jobberConnectionsTable.companyId, company.id),
      ),
    )
    .limit(1);
  if (!connection) {
    throw new Error("The booking's Jobber connection was not found");
  }
  return getValidConnectionToken(connection);
}

/**
 * Whether this booking is one we may send. Separate from the push itself so
 * the dashboard button can explain the situation instead of failing.
 */
export function jobberPushBlockedReason(
  company: Company,
  booking: Booking,
): string | null {
  // A synced booking may still be missing its quote — a push that fell over
  // half way, or one taken before quotes were raised with the booking. Only a
  // booking with both halves is finished, so a re-sync can fill in the rest.
  if (booking.jobberSynced && realQuoteId(booking)) {
    return "This booking is already in Jobber.";
  }
  if (
    booking.jobberVisitId ||
    booking.jobberSyncedJobId ||
    booking.jobberSyncedRequestId ||
    booking.jobberSyncedQuoteId
  ) {
    return "This booking came from Jobber — it's already there.";
  }
  // A multi-account booking belongs to its persisted connection. The primary
  // company's mirror may be disconnected while this exact account is healthy;
  // the connection-aware token lookup below is authoritative for bound rows.
  if (!booking.jobberConnectionId) {
    if (company.jobberNeedsReauth) {
      return REAUTH_REASON;
    }
    if (!company.jobberConnected || !company.jobberRefreshToken) {
      return "Connect Jobber before syncing bookings";
    }
  }
  return null;
}

/** What the owner is told, everywhere, when the Jobber grant has gone stale. */
export const REAUTH_REASON =
  "Jobber authorization has expired — reconnect Jobber to keep syncing.";

/**
 * Whether a refusal to push is the owner's to fix.
 *
 * A company that never connected Jobber, or a booking Jobber itself gave us,
 * is not a problem — writing "couldn't reach Jobber" on those bookings would
 * paint every row of a non-Jobber company red. An expired grant, or a
 * connection whose refresh token has gone missing, is the opposite: the owner
 * believes their bookings are flowing and they are not.
 */
export function jobberBlockNeedsOwnerAction(company: Company): boolean {
  if (!company.jobberConnected) return false;
  return Boolean(company.jobberNeedsReauth || !company.jobberRefreshToken);
}

function bookingAddress(booking: Booking): JobberAddress {
  return {
    street1: booking.customerAddress?.trim() || null,
    street2: booking.addressLine2?.trim() || null,
    city: booking.addressCity,
    province: booking.addressProvince,
    postalCode: booking.addressPostal,
  };
}

/**
 * What to call the work in Jobber.
 *
 * A booking can be saved before the caller says what they want done — the desk
 * would rather have half a booking than none. Jobber, though, gets a titled
 * request and a named quote line either way, so the blank becomes the plain
 * word for what this company does rather than an empty title or a stray dash.
 */
export function serviceLabel(booking: Booking): string {
  return booking.service.trim() || "Cleaning";
}

function scheduledLabel(company: Company, booking: Booking): string {
  // In the company's own timezone, not the server's — otherwise the time in
  // Jobber is a different hour from the one the dispatcher picked and the one
  // the customer was told.
  return booking.scheduledFor.toLocaleString("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: company.timezone,
  });
}

async function buildRequestNote(
  company: Company,
  booking: Booking,
): Promise<string> {
  let extractedAnswers: Array<{ field: string; value: string }> = [];
  if (booking.callId) {
    const [call] = await db
      .select()
      .from(callsTable)
      // Scoped to the company as well as the id. A booking should only ever
      // point at its own company's call, but this note is sent outside the
      // system, so it is not the place to take that on trust.
      .where(
        and(
          eq(callsTable.id, booking.callId),
          eq(callsTable.companyId, company.id),
        ),
      );
    extractedAnswers =
      (call?.extractedAnswers as typeof extractedAnswers) ?? [];
  }

  const scope = [
    booking.bedrooms != null ? `${booking.bedrooms} bed` : null,
    booking.bathrooms != null ? `${booking.bathrooms} bath` : null,
  ].filter(Boolean);
  const fullAddress = joinAddress(booking);

  return [
    booking.callId
      ? "Booking captured by the Book My Cleaning AI receptionist."
      : "Booking taken in Book My Cleaning.",
    `Service: ${serviceLabel(booking)}`,
    `Requested time: ${scheduledLabel(company, booking)}`,
    ...(booking.customerPhone.trim()
      ? [`Phone: ${booking.customerPhone}`]
      : []),
    ...(booking.customerEmail ? [`Email: ${booking.customerEmail}`] : []),
    ...(fullAddress ? [`Address: ${fullAddress}`] : []),
    ...(scope.length > 0 ? [`Home: ${scope.join(", ")}`] : []),
    ...(booking.extras && booking.extras.length > 0
      ? [`Extras: ${booking.extras.join(", ")}`]
      : []),
    ...(booking.frequency && booking.frequency !== "one_time"
      ? [`Frequency: ${frequencyLabel(booking.frequency)}`]
      : []),
    ...(booking.internalNotes ? [`Entry notes: ${booking.internalNotes}`] : []),
    ...(booking.tag ? [`Book My Cleaning verdict: ${booking.tag}`] : []),
    ...extractedAnswers.map((a) => `${a.field}: ${a.value}`),
  ].join("\n");
}

/**
 * Write a Jobber failure onto the booking and into the activity feed.
 *
 * Shared with the approve/schedule half of the integration so every Jobber
 * problem the office can see is recorded the same way — one banner on the
 * card, one line in the feed, whatever failed.
 */
export async function recordJobberFailure(
  company: Company,
  booking: Booking,
  message: string,
): Promise<Booking> {
  return recordPushFailure(company, booking, message);
}

async function recordPushFailure(
  company: Company,
  booking: Booking,
  message: string,
): Promise<Booking> {
  try {
    const contactFailure = isJobberClientSyncError(message);
    const contactPattern = `${JOBBER_CLIENT_SYNC_ERROR_PREFIX}%`;
    const [updated] = await db
      .update(bookingsTable)
      .set({
        // Contact corrections and the older quote/schedule/time-sheet flows
        // share one visible error field. Compose them atomically so whichever
        // fails second cannot make the first problem disappear.
        jobberSyncError: contactFailure
          ? sql<string>`case
              when ${bookingsTable.jobberSyncError} is null then ${message}
              when ${bookingsTable.jobberSyncError} like ${contactPattern}
                and position(${OTHER_JOBBER_ERROR_SEPARATOR} in ${bookingsTable.jobberSyncError}) > 0
                then ${message} || substring(
                  ${bookingsTable.jobberSyncError}
                  from position(${OTHER_JOBBER_ERROR_SEPARATOR} in ${bookingsTable.jobberSyncError})
                )
              when ${bookingsTable.jobberSyncError} like ${contactPattern}
                then ${message}
              else ${message} || ${OTHER_JOBBER_ERROR_SEPARATOR} || ${bookingsTable.jobberSyncError}
            end`
          : sql<string>`case
              when ${bookingsTable.jobberSyncError} like ${contactPattern}
                then ${bookingsTable.jobberSyncError} || ${OTHER_JOBBER_ERROR_SEPARATOR} || ${message}
              else ${message}
            end`,
        jobberSyncErrorAt: new Date(),
        jobberSyncAttempts: sql`${bookingsTable.jobberSyncAttempts} + 1`,
      })
      .where(eq(bookingsTable.id, booking.id))
      .returning();
    await db.insert(activityTable).values({
      companyId: company.id,
      type: "jobber_sync_failed",
      message: `Jobber sync failed for ${customerLabel(booking)}'s booking: ${message}`,
    });
    return updated ?? booking;
  } catch (err) {
    logger.error({ err }, "Failed to record Jobber sync failure");
    return booking;
  }
}

type QuoteLine = { name: string; quantity: number; unitPrice: number };

/**
 * The priced lines a Jobber quote for this booking should carry — the same
 * ones the quote calculator shows the office, and the same ones the customer
 * is texted.
 *
 * Frozen totals win when they exist: once a price has been promised by text,
 * that is the price, whatever today's settings would recompute.
 */
function quoteLinesFor(company: Company, booking: Booking): QuoteLine[] {
  const totals =
    booking.quoteSentTotals ?? computeQuoteTotals(company, booking);
  const lines: QuoteLine[] =
    totals.lineItems.length > 0
      ? totals.lineItems.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        }))
      : [
          {
            name: serviceLabel(booking),
            quantity: 1,
            unitPrice: totals.subtotal,
          },
        ];
  // Tax is configured on the connected Jobber account. Do not turn the
  // calculated tax into a product line: Jobber applies account tax to the
  // taxable service lines, and an explicit tax line would be taxed again.
  // The local quote still includes totals.taxAmount for the customer-facing
  // quote; Jobber receives only the pre-tax lines here.
  return lines;
}

function linesTotal(lines: QuoteLine[]): number {
  return lines.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
}

/**
 * Make sure this booking has exactly one quote in Jobber, carrying today's
 * price.
 *
 * Called twice over a booking's life: as a draft the moment the booking is
 * taken, and again if the office texts the customer a price. The second call
 * must never raise a second quote — it edits the draft that is already there,
 * which is why the create path claims `jobber_quote_id` before talking to
 * Jobber and the edit path works from the stored id.
 */
async function ensureJobberQuote(
  company: Company,
  booking: Booking,
): Promise<JobberPushResult> {
  let current = booking;
  const clientId = current.jobberClientId;
  const propertyId = current.jobberPropertyId;
  if (!clientId || !propertyId) {
    return {
      status: "skipped",
      reason: "This booking isn't in Jobber yet, so its quote can't be either.",
      booking: current,
    };
  }

  const lineItems = quoteLinesFor(company, current);
  if (linesTotal(lineItems) <= 0) {
    return {
      status: "skipped",
      reason: "This booking has no priced quote yet.",
      booking: current,
    };
  }
  const title = `${serviceLabel(current)} — ${scheduledLabel(company, current)}`;
  const message =
    [
      current.quoteNotes,
      current.tag ? `Book My Cleaning verdict: ${current.tag}` : null,
    ]
      .filter(Boolean)
      .join("\n") || null;

  const existingQuoteId = realQuoteId(current);
  if (existingQuoteId) {
    try {
      const accessToken = await getLinkedBookingAccessToken(company, current);
      const quote = await updateJobberQuote(accessToken, {
        quoteId: existingQuoteId,
        title,
        message,
        lineItems,
      });
      if (quote) {
        const recoveringFailure = Boolean(
          otherJobberError(current.jobberSyncError),
        );
        // A draft raised at booking time may have landed before Jobber
        // assigned it a number; take whatever it has now.
        if (
          quote.quoteNumber !== current.jobberQuoteNumber ||
          quote.webUri !== current.jobberQuoteWebUri
        ) {
          const [updated] = await db
            .update(bookingsTable)
            .set({
              jobberQuoteNumber: quote.quoteNumber,
              jobberQuoteWebUri: quote.webUri,
            })
            .where(
              and(
                eq(bookingsTable.id, current.id),
                eq(bookingsTable.jobberQuoteId, existingQuoteId),
              ),
            )
            .returning();
          current = updated ?? current;
        }
        const recovered = await clearNonContactJobberFailure(current);
        if (recoveringFailure) {
          await db.insert(activityTable).values({
            companyId: company.id,
            type: "jobber_synced",
            message: `Jobber sync recovered for ${customerLabel(current)}'s booking.`,
            bookingId: current.id,
          });
        }
        return {
          status: "synced",
          booking: recovered,
        };
      }
      // Jobber no longer has that quote — deleted in Jobber, most likely.
      // Forget it and raise a fresh one rather than failing forever.
      const [cleared] = await db
        .update(bookingsTable)
        .set({
          jobberQuoteId: null,
          jobberQuoteNumber: null,
          jobberQuoteWebUri: null,
        })
        .where(
          and(
            eq(bookingsTable.id, current.id),
            eq(bookingsTable.jobberQuoteId, existingQuoteId),
          ),
        )
        .returning();
      current = cleared ?? { ...current, jobberQuoteId: null };
    } catch (err) {
      logger.error(
        { err, bookingId: current.id },
        "Updating the Jobber quote failed",
      );
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      const updated = await recordPushFailure(company, current, errorMessage);
      return { status: "failed", error: errorMessage, booking: updated };
    }
  }

  const priorQuoteId = current.jobberQuoteId;
  const priorAge = claimAge(priorQuoteId);
  if (priorAge !== null && priorAge > Date.now() - PUSH_CLAIM_STALE_MS) {
    return {
      status: "skipped",
      reason: "This quote is already being sent to Jobber.",
      booking: current,
    };
  }
  const claim = `${PUSH_CLAIM_PREFIX}${Date.now()}`;
  const claimed = await db
    .update(bookingsTable)
    .set({ jobberQuoteId: claim })
    .where(
      and(
        eq(bookingsTable.id, current.id),
        eq(bookingsTable.companyId, company.id),
        priorQuoteId === null
          ? isNull(bookingsTable.jobberQuoteId)
          : eq(bookingsTable.jobberQuoteId, priorQuoteId),
      ),
    )
    .returning();
  if (claimed.length === 0) {
    return {
      status: "skipped",
      reason: "This quote is already being sent to Jobber.",
      booking: current,
    };
  }

  try {
    const accessToken = await getLinkedBookingAccessToken(company, current);
    const quote = await createJobberQuote(accessToken, {
      clientId,
      propertyId,
      // Hang the quote off the work request when there is one, so Jobber shows
      // the enquiry and the price as one thread rather than two loose items.
      // The request may be one our push raised (`jobberJobId`) or the one the
      // booking was born from — a Jobber-form lead or an imported request
      // (`jobberSyncedRequestId`). Either way it already exists in Jobber, so
      // reusing it is what keeps one enquiry from becoming two threads.
      requestId:
        current.jobberJobId && !isClaim(current.jobberJobId)
          ? current.jobberJobId
          : (current.jobberSyncedRequestId ?? null),
      title,
      message,
      lineItems,
    });

    const [updated] = await db
      .update(bookingsTable)
      .set({
        jobberQuoteId: quote.id,
        jobberQuoteNumber: quote.quoteNumber,
        jobberQuoteWebUri: quote.webUri,
        ...nonContactJobberSuccessFields(),
      })
      .where(
        and(
          eq(bookingsTable.id, current.id),
          eq(bookingsTable.jobberQuoteId, claim),
        ),
      )
      .returning();

    if (!updated) {
      logger.warn(
        { bookingId: current.id, quoteId: quote.id },
        "Jobber quote created but the booking's claim was taken; not recording it",
      );
      const [row] = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, current.id));
      return {
        status: "skipped",
        reason: "Another sync finished this quote first.",
        booking: row ?? current,
      };
    }

    await db.insert(activityTable).values({
      companyId: company.id,
      type: "jobber_synced",
      message: `${current.quoteSentAt ? "Quote" : "Draft quote"}${
        quote.quoteNumber ? ` #${quote.quoteNumber}` : ""
      } created in Jobber for ${customerLabel(current)}.`,
      bookingId: current.id,
    });

    return { status: "synced", booking: updated };
  } catch (err) {
    logger.error({ err, bookingId: current.id }, "Jobber quote push failed");
    await db
      .update(bookingsTable)
      .set({ jobberQuoteId: priorQuoteId })
      .where(
        and(
          eq(bookingsTable.id, current.id),
          eq(bookingsTable.jobberQuoteId, claim),
        ),
      );
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    const updated = await recordPushFailure(company, current, errorMessage);
    return { status: "failed", error: errorMessage, booking: updated };
  }
}

/**
 * A booking worked from the Leads inbox may be trailing the lead's own push:
 * form leads go to Jobber the moment they are submitted, and the desk can
 * convert one before that push has finished (or after it half-finished). The
 * ids are copied onto the booking at creation, but anything that landed on
 * the lead *since* — both pushes run on the same per-company queue, so the
 * lead's attempt has settled by the time this booking's push runs — is
 * adopted here, so the two paths can never mint two clients or two requests
 * for one enquiry.
 *
 * Conditional on the booking having no Jobber state of its own (and no claim
 * in flight), so nothing a previous push wrote is ever stepped on.
 */
async function adoptLeadJobberState(
  company: Company,
  booking: Booking,
): Promise<Booking> {
  if (booking.leadId == null) return booking;
  if (booking.jobberSynced || booking.jobberClientId || booking.jobberJobId) {
    return booking;
  }
  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.id, booking.leadId),
        eq(leadsTable.companyId, company.id),
      ),
    );
  if (!lead) return booking;
  const requestId =
    lead.jobberRequestId && !isClaim(lead.jobberRequestId)
      ? lead.jobberRequestId
      : null;
  if (!requestId && !lead.jobberClientId) return booking;
  const [updated] = await db
    .update(bookingsTable)
    .set(
      requestId
        ? {
            // The lead's request IS this booking's request. jobberJobId (our
            // outbound id) — never jobberSyncedRequestId, which would make
            // the booking look imported and block quoting and scheduling.
            jobberSynced: true,
            jobberJobId: requestId,
            jobberClientId: lead.jobberClientId,
            jobberPropertyId: lead.jobberPropertyId,
            jobberWebUri: lead.jobberWebUri,
          }
        : {
            // The lead's push failed after creating the client. Reuse it —
            // this push will raise the request on it rather than minting a
            // second customer.
            jobberClientId: lead.jobberClientId,
            jobberPropertyId: lead.jobberPropertyId,
          },
    )
    .where(
      and(
        eq(bookingsTable.id, booking.id),
        eq(bookingsTable.jobberSynced, false),
        isNull(bookingsTable.jobberClientId),
        isNull(bookingsTable.jobberJobId),
      ),
    )
    .returning();
  return updated ?? booking;
}

/**
 * Take back any Jobber-origin lead that is actually the echo of a request
 * this app just created: Jobber's REQUEST_CREATE webhook fires for our own
 * pushes too, and can arrive before the push records its request id. Only
 * untouched leads are removed — one the office already converted or
 * dismissed is theirs, not ours to erase. Only Jobber-origin leads qualify:
 * a form lead carrying this request id IS the enquiry the push was for,
 * never an echo of it. Never throws: the push must not fail over inbox
 * housekeeping. Shared with the lead push (leadJobberPush.ts), whose
 * requests fire the same webhook.
 */
export async function deleteEchoLeads(
  companyId: number,
  jobberRequestId: string,
): Promise<void> {
  try {
    const removed = await db
      .delete(leadsTable)
      .where(
        and(
          eq(leadsTable.companyId, companyId),
          eq(leadsTable.jobberRequestId, jobberRequestId),
          eq(leadsTable.source, "jobber"),
          eq(leadsTable.status, "new"),
        ),
      )
      .returning({ id: leadsTable.id });
    if (removed.length > 0) {
      logger.info(
        { companyId, jobberRequestId, leadIds: removed.map((l) => l.id) },
        "Removed echo lead(s) for a request this app created",
      );
    }
  } catch (err) {
    logger.warn({ err, companyId, jobberRequestId }, "Echo lead sweep failed");
  }
}

/**
 * Send one booking to Jobber as a work request, creating (or reusing) the
 * customer and their service address on the way.
 *
 * Returns rather than throws: this runs both behind a button and on its own
 * after a booking is created, and "Jobber said no" is a state the booking
 * carries, not a crash.
 */
export async function pushBookingToJobber(
  company: Company,
  booking: Booking,
): Promise<JobberPushResult> {
  const blocked = jobberPushBlockedReason(company, booking);
  if (blocked) return { status: "skipped", reason: blocked, booking };

  booking = await adoptLeadJobberState(company, booking);

  // The request is already over there; only the quote can still be missing.
  // A re-sync fills in that half rather than starting again.
  if (booking.jobberSynced) return ensureJobberQuote(company, booking);

  const age = claimAge(booking.jobberJobId);
  if (age !== null && age > Date.now() - PUSH_CLAIM_STALE_MS) {
    return {
      status: "skipped",
      reason: "This booking is already being sent to Jobber.",
      booking,
    };
  }

  // Claim BEFORE calling Jobber. The condition pins the exact value we read,
  // so only one caller wins even if two arrive at the same instant.
  const claim = `${PUSH_CLAIM_PREFIX}${Date.now()}`;
  const priorJobId = booking.jobberJobId;
  const claimed = await db
    .update(bookingsTable)
    .set({ jobberJobId: claim })
    .where(
      and(
        eq(bookingsTable.id, booking.id),
        eq(bookingsTable.companyId, company.id),
        eq(bookingsTable.jobberSynced, false),
        priorJobId === null
          ? isNull(bookingsTable.jobberJobId)
          : eq(bookingsTable.jobberJobId, priorJobId),
      ),
    )
    .returning();
  if (claimed.length === 0) {
    return {
      status: "skipped",
      reason: "This booking is already being sent to Jobber.",
      booking,
    };
  }

  try {
    // Once a booking has touched Jobber, its persisted connection owns every
    // follow-up call. Assignment and primary changes must never move a retry
    // into another workspace. Only a genuinely unbound first push chooses an
    // account from the current assignment (then primary as the fallback).
    let selectedConnectionId = booking.jobberConnectionId;
    if (!selectedConnectionId) {
      const [primaryAssignment] = await db
        .select({ jobberConnectionId: teamMembersTable.jobberConnectionId })
        .from(bookingAssignmentsTable)
        .innerJoin(
          teamMembersTable,
          eq(bookingAssignmentsTable.teamMemberId, teamMembersTable.id),
        )
        .where(eq(bookingAssignmentsTable.bookingId, booking.id))
        .orderBy(asc(bookingAssignmentsTable.id))
        .limit(1);
      selectedConnectionId = primaryAssignment?.jobberConnectionId ?? null;
    }

    let connection;
    if (selectedConnectionId) {
      [connection] = await db
        .select()
        .from(jobberConnectionsTable)
        .where(
          and(
            eq(jobberConnectionsTable.id, selectedConnectionId),
            eq(jobberConnectionsTable.companyId, company.id),
          ),
        )
        .limit(1);
      if (!connection) {
        throw new Error("The booking's Jobber connection was not found");
      }
    } else {
      [connection] = await db
        .select()
        .from(jobberConnectionsTable)
        .where(
          and(
            eq(jobberConnectionsTable.companyId, company.id),
            eq(jobberConnectionsTable.isPrimary, true),
          ),
        )
        .limit(1);
    }
    const accessToken = connection
      ? await getValidConnectionToken(connection)
      : await getValidAccessToken(company);

    const address = bookingAddress(booking);

    let clientId = booking.jobberClientId;
    let properties: JobberProperty[] = [];
    // A booking worked from the Leads inbox always becomes a NEW Jobber
    // client. Matching by phone is how an ad enquiry quietly lands on top of
    // an existing client record, and the owner would rather make that call
    // themselves: a merge done inside Jobber can be seen and undone, this
    // cannot. Ordinary bookings still reuse the customer Jobber already has.
    if (!clientId && booking.leadId == null) {
      const found = await findJobberClient(accessToken, booking.customerPhone);
      if (found) {
        clientId = found.id;
        properties = found.properties;
      }
    }
    if (!clientId) {
      const created = await createJobberClient(accessToken, {
        // Jobber requires a client name; a nameless booking goes over under
        // its phone number (or "No name") rather than failing the push.
        name: customerLabel(booking),
        phone: booking.customerPhone,
        email: booking.customerEmail,
        address,
      });
      clientId = created.id;
      properties = created.properties;
    }
    // Store the client the moment we have one. If the request below fails,
    // the customer already exists in Jobber — forgetting them here is what
    // used to leave a stray client behind on every failed push.
    await db
      .update(bookingsTable)
      .set({
        jobberClientId: clientId,
        jobberConnectionId: connection?.id ?? null,
      })
      .where(eq(bookingsTable.id, booking.id));
    booking = {
      ...booking,
      jobberClientId: clientId,
      jobberConnectionId: connection?.id ?? null,
    };
    // The client directory learns the Jobber id the moment we do, so the
    // Clients page shows this customer as linked. Never throws.
    await recordClientContact(company.id, {
      name: booking.customerName,
      phone: booking.customerPhone,
      email: booking.customerEmail,
      jobberClientId: clientId,
      source: booking.leadId != null ? "lead" : "booking",
    });

    let propertyId = booking.jobberPropertyId;
    if (!propertyId) {
      propertyId = await ensureJobberProperty(accessToken, {
        clientId,
        existing: properties,
        address,
      });
      if (propertyId) {
        await db
          .update(bookingsTable)
          .set({ jobberPropertyId: propertyId })
          .where(eq(bookingsTable.id, booking.id));
      }
    } else {
      await updateJobberProperty(accessToken, { propertyId, address });
    }

    const request = await createJobberRequest(accessToken, {
      clientId,
      propertyId,
      title: `${serviceLabel(booking)} — ${customerLabel(booking)} (requested ${scheduledLabel(company, booking)})`,
    });

    // Jobber fires REQUEST_CREATE for requests WE create too, and its
    // webhook can outrun the id write below — the echo would land in the
    // Leads inbox as a brand-new enquiry. Delete any echo the moment the
    // request id is known, and again after the id is durably recorded (the
    // webhook re-checks after inserting, so between the two sides no
    // interleaving lets an echo survive).
    await deleteEchoLeads(company.id, request.id);

    await tryAttachRequestNote(
      accessToken,
      request.id,
      await buildRequestNote(company, booking),
    );

    const [updated] = await db
      .update(bookingsTable)
      .set({
        jobberSynced: true,
        jobberJobId: request.id,
        jobberClientId: clientId,
        jobberConnectionId: connection?.id ?? null,
        jobberPropertyId: propertyId,
        jobberWebUri: request.jobberWebUri,
        ...nonContactJobberSuccessFields(),
      })
      // Only if we still hold the claim: anything else touching this row means
      // our view of it is stale and the write is not ours to make.
      .where(
        and(
          eq(bookingsTable.id, booking.id),
          eq(bookingsTable.jobberJobId, claim),
        ),
      )
      .returning();

    if (!updated) {
      // Our claim was gone by the time Jobber answered — a very slow call whose
      // lease went stale, most likely. Somebody else owns this booking's Jobber
      // state now, so say nothing and claim nothing; announcing a sync we
      // didn't finish would put a wrong link in front of the office.
      logger.warn(
        { bookingId: booking.id, requestId: request.id },
        "Jobber request created but the booking's claim was taken; not recording it",
      );
      const [current] = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, booking.id));
      return {
        status: "skipped",
        reason: "Another sync finished this booking first.",
        booking: current ?? booking,
      };
    }

    // Second half of the echo guard: the request id is now on the booking,
    // so any echo lead the webhook slipped in meanwhile comes back out.
    await deleteEchoLeads(company.id, request.id);

    await db.insert(activityTable).values({
      companyId: company.id,
      type: "jobber_synced",
      message: `Booking for ${customerLabel(booking)} synced to Jobber as a work request.`,
      bookingId: booking.id,
    });

    // Then the money, as a draft quote hung off that request. The office
    // expects to open Jobber and find the price already written up, not to
    // have to text the customer first to make it appear.
    //
    // The request landing is what makes this booking "in Jobber", so a quote
    // that fails afterwards doesn't undo it: the reason is written on the
    // booking and into the feed, and the Sync button finishes the job.
    const withQuote = await ensureJobberQuote(company, updated);
    return { status: "synced", booking: withQuote.booking };
  } catch (err) {
    logger.error({ err, bookingId: booking.id }, "Jobber push failed");
    // Release the claim so a retry — by the office, or by the next attempt —
    // isn't locked out for five minutes.
    await db
      .update(bookingsTable)
      .set({ jobberJobId: priorJobId })
      .where(
        and(
          eq(bookingsTable.id, booking.id),
          eq(bookingsTable.jobberJobId, claim),
        ),
      );
    const message = err instanceof Error ? err.message : "Unknown error";
    const updated = await recordPushFailure(company, booking, message);
    return { status: "failed", error: message, booking: updated };
  }
}

/**
 * Raise (or refresh) the Jobber quote for a booking the customer was just
 * texted a price for, so the office sees the same money in both places.
 *
 * A booking taken in the app already raised a draft quote for itself, so this
 * usually edits that draft rather than creating anything: one booking, one
 * quote, whatever order things happened in. The booking's client, property
 * and request are pushed first when they don't exist yet — Jobber will not
 * take a quote without them.
 */
export async function pushQuoteToJobber(
  company: Company,
  booking: Booking,
): Promise<JobberPushResult> {
  if (company.jobberNeedsReauth) {
    return { status: "skipped", reason: REAUTH_REASON, booking };
  }
  if (!company.jobberConnected || !company.jobberRefreshToken) {
    return { status: "skipped", reason: "Jobber isn't connected.", booking };
  }

  let current = booking;
  if (!current.jobberClientId || !current.jobberPropertyId) {
    const hadQuote = realQuoteId(current) !== null;
    const pushed = await pushBookingToJobber(company, current);
    if (pushed.status === "failed") return pushed;
    current = pushed.booking;
    // That push raised the quote itself, from these same frozen totals.
    // Re-reading it out of Jobber to confirm would spend rate budget to
    // learn nothing.
    if (!hadQuote && realQuoteId(current)) {
      return { status: "synced", booking: current };
    }
  }

  return ensureJobberQuote(company, current);
}

/**
 * One outbound push at a time per company.
 *
 * A morning's worth of bookings entered back to back would otherwise fire
 * several multi-call conversations at Jobber at once — and Jobber's rate
 * budget is per account, shared with the calendar pull, so a burst throttles
 * the whole integration rather than just itself. Queuing also means two
 * bookings for the same new customer can't each decide that customer doesn't
 * exist yet and create them twice.
 *
 * In-process only: it bounds what this server does, not what two servers
 * would. The per-booking claim is what actually prevents double sends.
 */
const companyQueues = new Map<number, Promise<unknown>>();

function runQueued<T>(companyId: number, work: () => Promise<T>): Promise<T> {
  const prior = companyQueues.get(companyId) ?? Promise.resolve();
  const next = prior.then(work, work);
  // Keep the chain alive past a failure, and let the map forget a company once
  // its queue has drained.
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  companyQueues.set(companyId, settled);
  void settled.then(() => {
    if (companyQueues.get(companyId) === settled) {
      companyQueues.delete(companyId);
    }
  });
  return next;
}

/**
 * Run Jobber work for a company behind whatever else is already queued for it.
 * Exposed so approving and rescheduling share the one outbound lane rather
 * than opening a second front on the same rate budget.
 */
export function runQueuedForCompany<T>(
  companyId: number,
  work: () => Promise<T>,
): Promise<T> {
  return runQueued(companyId, work);
}

/** Send a booking, waiting behind any other push for the same company. */
export function queueBookingPush(
  company: Company,
  booking: Booking,
): Promise<JobberPushResult> {
  return runQueued(company.id, () => pushBookingToJobber(company, booking));
}

/** Raise a quote, waiting behind any other push for the same company. */
export function queueQuotePush(
  company: Company,
  booking: Booking,
): Promise<JobberPushResult> {
  return runQueued(company.id, () => pushQuoteToJobber(company, booking));
}

/**
 * Fire-and-forget push used by the paths that create bookings: the desk, the
 * website, and the AI receptionist. A booking must be saved and answered for
 * whatever Jobber does next, so this never blocks the response and never
 * throws — a failure is recorded on the booking and shown in the feed, and
 * the office can press the button.
 *
 * The returned promise exists for tests; production callers ignore it.
 */
export function scheduleJobberPush(
  company: Company,
  booking: Booking,
): Promise<void> {
  const blocked = jobberPushBlockedReason(company, booking);
  if (blocked) {
    // A refusal the owner has to act on is written onto the booking exactly
    // as a Jobber failure is, and into the feed with it. Returning quietly
    // here is what let a whole company's bookings pile up looking saved while
    // nothing at all reached Jobber.
    const bookingIsAlreadyThere =
      booking.jobberSynced ||
      Boolean(booking.jobberVisitId) ||
      Boolean(booking.jobberSyncedJobId);
    if (!bookingIsAlreadyThere && jobberBlockNeedsOwnerAction(company)) {
      return recordPushFailure(company, booking, blocked).then(() => undefined);
    }
    return Promise.resolve();
  }
  return queueBookingPush(company, booking)
    .then((result) => {
      if (result.status === "failed") {
        logger.warn(
          { bookingId: booking.id, error: result.error },
          "Automatic Jobber push failed",
        );
      }
    })
    .catch((err) => {
      logger.error(
        { err, bookingId: booking.id },
        "Automatic Jobber push threw",
      );
    });
}
