import { describe, expect, it } from "vitest";
import type { Booking, Company } from "@workspace/db";
import { bookingJobberManualSyncBlockedReason } from "./bookingJobberSync";

const company = {
  jobberConnected: true,
  jobberNeedsReauth: false,
  jobberRefreshToken: "encrypted-refresh",
} as Company;

const booking = {
  jobberConnectionId: null,
  jobberSyncError: "Jobber is temporarily unavailable",
} as Booking;

describe("bookingJobberManualSyncBlockedReason", () => {
  it("uses a booking's secondary connection even when the primary needs reauth", () => {
    expect(
      bookingJobberManualSyncBlockedReason(
        { ...company, jobberNeedsReauth: true },
        { ...booking, jobberConnectionId: 91 },
      ),
    ).toBeNull();
  });

  it("requires reconnecting an unbound booking's primary account", () => {
    expect(
      bookingJobberManualSyncBlockedReason(
        { ...company, jobberNeedsReauth: true },
        booking,
      ),
    ).toContain("reconnect Jobber");
  });

  it("refuses generic sync for a manual-only visit failure", () => {
    expect(
      bookingJobberManualSyncBlockedReason(company, {
        ...booking,
        jobberSyncError:
          "Could not update this job's Jobber visit: unavailable",
      }),
    ).toContain("cannot be retried with Sync to Jobber");
  });
});
