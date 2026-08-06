import { describe, expect, it } from "vitest";
import {
  CLEANER_REDACTED_NULL_KEYS,
  redactBookingForCleaner,
} from "./bookingVisibility";

function fullBooking() {
  return {
    id: 7,
    customerName: "Dana",
    customerPhone: "+15550001111",
    customerAddress: "12 Main St",
    service: "Deep clean",
    scheduledFor: "2026-08-05T16:00:00.000Z",
    status: "confirmed",
    crew: [{ id: 3, name: "Sam", role: "cleaner" }],
    quoteHours: 3,
    quoteCrewLabel: "2 cleaners",
    quoteHourlyRate: 65,
    quoteFuelSurcharge: 10,
    quoteDiscountAmount: 5,
    quoteReferralSource: "google",
    quotedAmount: 200,
    quoteDeposit: 50,
    quoteNotes: "Gate code 1234",
    quoteMessage: "Hi Dana...",
    quoteSentAt: "2026-08-01T00:00:00.000Z",
    quoteUrl: "https://example.com/q/abc",
    quoteApprovedAt: "2026-08-02T00:00:00.000Z",
    depositPaidAt: "2026-08-03T00:00:00.000Z",
    depositPaidAmount: 50,
    quoteTotals: { total: 230 },
    quoteSentTotals: { total: 230 },
    needsTimeReview: false,
    timeReviewPreviousTimezone: null,
    jobberSynced: true,
    jobberJobId: "J1",
    jobberClientId: "C1",
    jobberWebUri: "https://jobber.example/j/1",
    jobberSyncError: "boom",
    jobberSyncErrorAt: "2026-08-04T00:00:00.000Z",
    createdAt: "2026-07-30T00:00:00.000Z",
  };
}

describe("redactBookingForCleaner", () => {
  it("nulls every pricing, quote-lifecycle, and Jobber field", () => {
    const redacted = redactBookingForCleaner(fullBooking());
    for (const key of CLEANER_REDACTED_NULL_KEYS) {
      expect(redacted[key], key).toBeNull();
    }
    expect(redacted.jobberSynced).toBe(false);
  });

  it("keeps the job essentials a cleaner needs", () => {
    const redacted = redactBookingForCleaner(fullBooking());
    expect(redacted.customerName).toBe("Dana");
    expect(redacted.customerAddress).toBe("12 Main St");
    expect(redacted.service).toBe("Deep clean");
    expect(redacted.scheduledFor).toBe("2026-08-05T16:00:00.000Z");
    expect(redacted.status).toBe("confirmed");
    expect(redacted.crew).toEqual([{ id: 3, name: "Sam", role: "cleaner" }]);
    expect(redacted.quoteNotes).toBe("Gate code 1234");
  });

  it("does not mutate the input", () => {
    const original = fullBooking();
    redactBookingForCleaner(original);
    expect(original.quotedAmount).toBe(200);
    expect(original.jobberSynced).toBe(true);
  });
});
