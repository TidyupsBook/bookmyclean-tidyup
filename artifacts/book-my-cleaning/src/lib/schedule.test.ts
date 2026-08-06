import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatPrice,
  shiftDay,
  sortJobsByTime,
  todayInZone,
  totalDurationMinutes,
} from "./schedule";
import type { ScheduleJob } from "@workspace/api-client-react";

function job(overrides: Partial<ScheduleJob>): ScheduleJob {
  return {
    bookingId: 1,
    customerName: "Acme",
    customerAddress: "1 Main St",
    scheduledFor: "2026-08-08T16:00:00.000Z",
    durationMinutes: 60,
    status: "confirmed",
    price: null,
    ...overrides,
  };
}

describe("todayInZone", () => {
  it("uses the company zone, not the browser, across the date line", () => {
    // 06:30 UTC is still the previous evening in Denver (UTC-6 in summer).
    const at = new Date("2026-08-08T06:30:00.000Z");
    expect(todayInZone("America/Denver", at)).toBe("2026-08-08");
    expect(todayInZone("Australia/Sydney", at)).toBe("2026-08-08");
    // 02:00 UTC is still Aug 7 evening in Denver but already Aug 8 in Sydney.
    const at2 = new Date("2026-08-08T02:00:00.000Z");
    expect(todayInZone("America/Denver", at2)).toBe("2026-08-07");
    expect(todayInZone("Australia/Sydney", at2)).toBe("2026-08-08");
  });
});

describe("shiftDay", () => {
  it("steps forward and back", () => {
    expect(shiftDay("2026-08-08", 1)).toBe("2026-08-09");
    expect(shiftDay("2026-08-08", -1)).toBe("2026-08-07");
  });

  it("rolls across month boundaries", () => {
    expect(shiftDay("2026-08-31", 1)).toBe("2026-09-01");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("leaves malformed input untouched", () => {
    expect(shiftDay("nope", 1)).toBe("nope");
  });
});

describe("sortJobsByTime", () => {
  it("orders earliest first, breaking ties by name", () => {
    const jobs = [
      job({ bookingId: 1, scheduledFor: "2026-08-08T18:00:00.000Z" }),
      job({ bookingId: 2, scheduledFor: "2026-08-08T09:00:00.000Z" }),
      job({
        bookingId: 3,
        scheduledFor: "2026-08-08T09:00:00.000Z",
        customerName: "Aaa",
      }),
    ];
    expect(sortJobsByTime(jobs).map((j) => j.bookingId)).toEqual([3, 2, 1]);
  });

  it("does not mutate the input", () => {
    const jobs = [
      job({ bookingId: 1, scheduledFor: "2026-08-08T18:00:00.000Z" }),
      job({ bookingId: 2, scheduledFor: "2026-08-08T09:00:00.000Z" }),
    ];
    sortJobsByTime(jobs);
    expect(jobs.map((j) => j.bookingId)).toEqual([1, 2]);
  });
});

describe("totalDurationMinutes", () => {
  it("sums lane durations", () => {
    expect(
      totalDurationMinutes([
        job({ durationMinutes: 60 }),
        job({ durationMinutes: 90 }),
      ]),
    ).toBe(150);
  });
});

describe("formatDuration", () => {
  it("formats minutes, hours and mixed", () => {
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(60)).toBe("1 hr");
    expect(formatDuration(150)).toBe("2 hr 30 min");
    expect(formatDuration(0)).toBe("");
  });
});

describe("formatPrice", () => {
  it("formats a positive price and hides empty ones", () => {
    expect(formatPrice(120)).toBe("$120.00");
    expect(formatPrice(0)).toBeNull();
    expect(formatPrice(null)).toBeNull();
    expect(formatPrice(undefined)).toBeNull();
  });
});
