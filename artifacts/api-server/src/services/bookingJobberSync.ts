/**
 * The one decision shared by the owner's retry button and the automatic
 * booking retry sweep.
 *
 * A contact correction is a different Jobber operation from creating a
 * request. Keeping that branch here prevents the background sweep from
 * accidentally re-pushing an already-linked booking when the customer details
 * are the only part that failed.
 */
import {
  isJobberClientSyncError,
  queueBookingClientUpdate,
  type JobberClientSyncResult,
} from "./jobberClientSync";
import {
  isClaim,
  otherJobberError,
  queueBookingPush,
  type JobberPushResult,
} from "./jobberPush";
import type { Booking, Company } from "@workspace/db";

export type BookingJobberSyncResult = JobberClientSyncResult | JobberPushResult;

/**
 * Scheduling and visit edits have their own Jobber operations; the shared
 * booking action below only repeats contact corrections and request/quote
 * pushes. Leave those distinct failures untouched rather than count a skipped
 * ordinary push as a retry. Connection-bound schedule operations also still
 * need booking-specific credential support before they can safely join here.
 */
export function supportsAutomaticBookingRetry(booking: Booking): boolean {
  let retryError = booking.jobberSyncError;
  if (isJobberClientSyncError(retryError)) {
    retryError = otherJobberError(retryError);
    if (!retryError) return true;
  }
  if (
    retryError?.startsWith("Could not update this job's Jobber visit:") ||
    retryError?.startsWith(
      "This job is in Jobber but its visit couldn't be identified",
    )
  ) {
    return false;
  }

  const hasRealQuote = Boolean(
    booking.jobberQuoteId && !isClaim(booking.jobberQuoteId),
  );
  const hasApprovedBooking = Boolean(
    booking.clientApprovedAt ||
    booking.quoteApprovedAt ||
    (booking.jobberSyncedQuoteId && booking.status === "confirmed"),
  );
  const hasCreatedJob = Boolean(
    booking.jobberCreatedJobId ||
    booking.jobberCreatedVisitId ||
    booking.jobberSyncedJobId ||
    booking.jobberVisitId,
  );
  if (hasRealQuote && hasApprovedBooking && !hasCreatedJob) return false;
  return true;
}

/**
 * Explain why the generic owner-facing Sync to Jobber action cannot run.
 *
 * Connection-bound bookings deliberately ignore the primary company's
 * credential state: their own connection is resolved by the push service.
 */
export function bookingJobberManualSyncBlockedReason(
  company: Company,
  booking: Booking,
): string | null {
  if (booking.jobberSyncError && !supportsAutomaticBookingRetry(booking)) {
    return "This Jobber failure cannot be retried with Sync to Jobber. Retry the scheduling action or update the visit in Jobber.";
  }
  if (booking.jobberConnectionId) return null;
  if (company.jobberNeedsReauth) {
    return "Jobber authorization has expired — reconnect Jobber to keep syncing.";
  }
  if (!company.jobberConnected || !company.jobberRefreshToken) {
    return "Connect Jobber before syncing bookings";
  }
  return null;
}

export function queueBookingJobberSync(
  company: Company,
  booking: Booking,
): Promise<BookingJobberSyncResult> {
  return queueBookingJobberSyncSteps(company, booking);
}

async function queueBookingJobberSyncSteps(
  company: Company,
  booking: Booking,
): Promise<BookingJobberSyncResult> {
  if (
    !booking.jobberClientId ||
    !isJobberClientSyncError(booking.jobberSyncError)
  ) {
    return queueBookingPush(company, booking);
  }

  const contact = await queueBookingClientUpdate(company, booking);
  if (contact.status === "failed") return contact;

  const current = contact.booking;
  const alreadyLinked =
    current.jobberSynced ||
    Boolean(current.jobberVisitId) ||
    Boolean(current.jobberSyncedJobId) ||
    Boolean(current.jobberSyncedRequestId) ||
    Boolean(current.jobberSyncedQuoteId);

  // A contact error can be composed with an older booking/quote error in the
  // one visible field. Repair the contact first, then immediately finish the
  // remaining operation just as the original manual route did.
  if (current.jobberSyncError) {
    return queueBookingPush(company, current);
  }
  if (alreadyLinked) return contact;
  return queueBookingPush(company, current);
}
