import { describe, expect, it } from "vitest";
import {
  collapseRecurringBookings,
  isRecurringBooking,
} from "./recurringBookings";

const booking = (id: number, scheduledFor: string, extra = {}) =>
  ({
    id,
    customerName: "Alex Customer",
    customerPhone: "780-555-0100",
    customerAddress: "1 Main Street",
    service: "Recurring clean",
    frequency: null,
    status: "confirmed",
    scheduledFor,
    jobberClientId: 42,
    ...extra,
  }) as any;

describe("recurring booking display", () => {
  it("recognizes recurring service names and frequencies", () => {
    expect(isRecurringBooking(booking(1, "2026-08-27T15:00:00Z"))).toBe(true);
    expect(
      isRecurringBooking(
        booking(2, "2026-08-27T15:00:00Z", {
          service: "Standard clean",
          frequency: "biweekly",
        }),
      ),
    ).toBe(true);
    expect(
      isRecurringBooking(
        booking(3, "2026-08-27T15:00:00Z", {
          service: "Move-in clean",
          frequency: "one_time",
        }),
      ),
    ).toBe(false);
  });

  it("keeps only the next non-canceled visit per recurring customer", () => {
    const result = collapseRecurringBookings(
      [
        booking(1, "2026-08-20T15:00:00Z"),
        booking(2, "2026-08-27T15:00:00Z"),
        booking(3, "2026-09-03T15:00:00Z"),
        booking(4, "2026-08-25T15:00:00Z", {
          customerName: "Different Customer",
          customerPhone: "780-555-0199",
          jobberClientId: 43,
        }),
      ],
      false,
      new Date("2026-08-24T12:00:00Z").getTime(),
    );
    expect(result.bookings.map((item) => item.id)).toEqual([2, 4]);
    expect(result.groupCount).toBe(2);
    expect(result.hiddenCount).toBe(2);
  });

  it("returns the full series when expanded", () => {
    const result = collapseRecurringBookings(
      [booking(1, "2026-08-27T15:00:00Z"), booking(2, "2026-09-03T15:00:00Z")],
      true,
    );
    expect(result.bookings.map((item) => item.id)).toEqual([1, 2]);
    expect(result.hiddenCount).toBe(0);
  });
});
