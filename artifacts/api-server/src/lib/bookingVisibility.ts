/**
 * What a cleaner's device is allowed to receive about a booking.
 *
 * Filtering assigned jobs in SQL is scope; this is content. A cleaner gets
 * the job essentials — when, where, who, what — and none of the business's
 * money or Jobber plumbing. Redacted at the API boundary so hidden UI can
 * never be defeated by reading the raw response.
 */

/** Serialized-booking keys a cleaner must never receive a value for. */
export const CLEANER_REDACTED_NULL_KEYS = [
  "quoteHours",
  "quoteCrewLabel",
  "quoteHourlyRate",
  "quoteFuelSurcharge",
  "quoteDiscountAmount",
  "quoteReferralSource",
  "quotedAmount",
  "quoteDeposit",
  "quoteMessage",
  "quoteSentAt",
  "quoteUrl",
  "quoteApprovedAt",
  "depositPaidAt",
  "depositPaidAmount",
  "quoteTotals",
  "quoteSentTotals",
  "jobberJobId",
  "jobberClientId",
  "jobberWebUri",
  "jobberSyncError",
  "jobberSyncErrorAt",
] as const;

type SerializedBookingLike = Record<string, unknown>;

export function redactBookingForCleaner<T extends SerializedBookingLike>(
  serialized: T,
): T {
  const redacted: SerializedBookingLike = { ...serialized };
  for (const key of CLEANER_REDACTED_NULL_KEYS) {
    redacted[key] = null;
  }
  // Booleans in the contract; "no information" rather than sync state.
  redacted["jobberSynced"] = false;
  return redacted as T;
}
