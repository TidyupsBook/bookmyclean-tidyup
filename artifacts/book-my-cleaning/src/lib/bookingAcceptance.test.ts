/**
 * The rules behind the one-click accept flow.
 *
 * "Needs acceptance" decides which bookings get the prominent Accept button,
 * so it must never light up work that is already agreed — especially jobs
 * pulled from Jobber's calendar, which arrive as "confirmed" without any
 * local approval fields. And sameCrew guards the accept flow's crew write:
 * a false negative would spam the activity feed with no-op "crew assigned"
 * entries on every accept.
 */
import { describe, expect, it } from "vitest";
import type { Booking } from "@workspace/api-client-react";
import {
  awaitingJobberSchedule,
  bookingQueue,
  clientApproved,
  needsAcceptance,
  sameCrew,
  scheduleBlockedReason,
} from "./bookingAcceptance";

function booking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: 1,
    customerName: "Jay",
    customerPhone: "555-0100",
    service: "Deep clean",
    scheduledFor: "2026-08-20T14:00:00.000Z",
    status: "pending",
    quoteTotals: null,
    needsTimeReview: false,
    jobberSynced: false,
    ...overrides,
  } as Booking;
}

describe("clientApproved", () => {
  it("counts a quote-page approval or an office-recorded one, nothing else", () => {
    expect(clientApproved(booking())).toBe(false);
    expect(
      clientApproved(booking({ quoteApprovedAt: "2026-08-10T00:00:00Z" })),
    ).toBe(true);
    expect(
      clientApproved(booking({ clientApprovedAt: "2026-08-10T00:00:00Z" })),
    ).toBe(true);
    // A texted quote is an offer, not an agreement.
    expect(
      clientApproved(booking({ quoteSentAt: "2026-08-10T00:00:00Z" })),
    ).toBe(false);
  });
});

describe("scheduleBlockedReason", () => {
  const quoted = booking({ jobberQuoteId: "quo_1" });
  it("names the first thing the owner must fix", () => {
    expect(scheduleBlockedReason(quoted, false, true)).toBe(
      "reconnect Jobber first",
    );
    expect(scheduleBlockedReason(quoted, false, false)).toBe(
      "connect Jobber first",
    );
    expect(scheduleBlockedReason(booking(), true, false)).toBe(
      "no Jobber quote yet",
    );
    expect(scheduleBlockedReason(quoted, true, false)).toBeNull();
  });
});

describe("needsAcceptance", () => {
  it("is exactly: pending and nobody has recorded a yes", () => {
    expect(needsAcceptance(booking())).toBe(true);
    expect(
      needsAcceptance(booking({ clientApprovedAt: "2026-08-10T00:00:00Z" })),
    ).toBe(false);
  });

  it("never lights up jobs imported from Jobber's calendar", () => {
    // The pull writes these as confirmed with no local approval fields —
    // the customer already agreed over in Jobber.
    expect(
      needsAcceptance(booking({ status: "confirmed", jobberSynced: true })),
    ).toBe(false);
  });

  it("leaves finished and canceled work alone", () => {
    expect(needsAcceptance(booking({ status: "completed" }))).toBe(false);
    expect(needsAcceptance(booking({ status: "canceled" }))).toBe(false);
  });
});

describe("awaitingJobberSchedule", () => {
  const accepted = booking({
    status: "confirmed",
    clientApprovedAt: "2026-08-10T00:00:00Z",
  });
  it("is accepted work that hasn't landed on Jobber's calendar", () => {
    expect(awaitingJobberSchedule(accepted)).toBe(true);
    expect(
      awaitingJobberSchedule({ ...accepted, jobberCreatedJobId: "job_1" }),
    ).toBe(false);
    expect(awaitingJobberSchedule(booking())).toBe(false);
    expect(
      awaitingJobberSchedule({ ...accepted, status: "completed" } as Booking),
    ).toBe(false);
  });
});

describe("bookingQueue", () => {
  it("separates response, approved, and scheduled work", () => {
    expect(bookingQueue(booking())).toBe("awaiting_response");
    expect(
      bookingQueue(booking({ clientApprovedAt: "2026-08-10T00:00:00Z" })),
    ).toBe("approved");
    expect(
      bookingQueue(
        booking({
          status: "confirmed",
          jobberSynced: true,
          jobberCreatedJobId: "job_1",
        }),
      ),
    ).toBe("scheduled");
  });
});

describe("sameCrew", () => {
  it("ignores order, catches every real difference", () => {
    expect(sameCrew([1, 2], [2, 1])).toBe(true);
    expect(sameCrew([], [])).toBe(true);
    expect(sameCrew([1], [1, 2])).toBe(false);
    expect(sameCrew([1, 3], [1, 2])).toBe(false);
  });
});
