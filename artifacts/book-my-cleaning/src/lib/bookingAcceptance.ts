import type { Booking } from "@workspace/api-client-react";

/**
 * Has the client actually agreed? The app may have recorded it directly, or
 * the Jobber mirror may have observed the quote as approved/converted.
 */
export function clientApproved(booking: Booking): boolean {
  return Boolean(
    booking.quoteApprovedAt ||
    booking.clientApprovedAt ||
    jobberApprovalObserved(booking),
  );
}

/** Jobber's own quote status says the customer already approved it. */
export function jobberApprovalObserved(booking: Booking): boolean {
  const status = booking.jobberQuoteStatus?.toLowerCase();
  return status === "approved" || status === "converted";
}

/**
 * Why "Approve & schedule" can't run yet, in words the owner can act on.
 * Null means it can. One definition for the kebab menu, the card button and
 * the detail dialog, so the reason and the disabled state can't drift apart.
 */
export function scheduleBlockedReason(
  booking: Booking,
  jobberConnected: boolean,
  jobberNeedsReauth: boolean,
): string | null {
  if (jobberNeedsReauth) return "reconnect Jobber first";
  if (!jobberConnected) return "connect Jobber first";
  if (!booking.jobberQuoteId) return "no Jobber quote yet";
  return null;
}

/**
 * The bookings the office still has to act on: nobody has recorded a yes yet
 * and the job hasn't earned (or lost) a final status. Jobs pulled from
 * Jobber's calendar arrive as "confirmed" — the customer already agreed over
 * there — so only "pending" work counts as waiting for acceptance.
 */
export function needsAcceptance(booking: Booking): boolean {
  return booking.status === "pending" && !clientApproved(booking);
}

/**
 * Accepted, but not yet on Jobber's calendar — the second half of the accept
 * flow still applies (or failed and deserves a retry).
 */
export function awaitingJobberSchedule(booking: Booking): boolean {
  return (
    booking.status !== "canceled" &&
    booking.status !== "completed" &&
    clientApproved(booking) &&
    !booking.jobberCreatedJobId
  );
}

export type BookingQueue =
  "unscheduled" | "awaiting_response" | "approved" | "scheduled";

/** The plain-language work queue a dispatcher needs to see for one booking. */
export function bookingQueue(booking: Booking): BookingQueue {
  if (needsAcceptance(booking)) return "awaiting_response";
  if (awaitingJobberSchedule(booking)) return "approved";
  return "scheduled";
}

/**
 * Same people on the job, order ignored. Used to skip the crew write when an
 * accept confirms whoever was already assigned — a no-op save would still
 * announce "crew assigned" to the activity feed.
 */
export function sameCrew(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((id) => set.has(id));
}
