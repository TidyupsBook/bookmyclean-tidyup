import { describe, expect, it } from "vitest";
import {
  dayKeyInTz,
  formatDayFromKey,
  formatDayInTz,
  formatTimeInTz,
  isValidTimeZone,
  isoToZonedInput,
  nextDayKey,
  zonedInputToIso,
} from "./format";

describe("strict company-timezone handling (no device fallback)", () => {
  it("flags invalid timezones so screens can show an error state", () => {
    expect(isValidTimeZone("America/Chicago")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("throws (rather than silently using device time) for a bad timezone", () => {
    expect(() => dayKeyInTz("2026-08-05T16:00:00Z", "Not/AZone")).toThrow();
    expect(() => formatTimeInTz("2026-08-05T16:00:00Z", "Not/AZone")).toThrow();
    expect(() => formatDayInTz("2026-08-05T16:00:00Z", "Not/AZone")).toThrow();
  });
});

describe("dayKeyInTz", () => {
  it("buckets an evening UTC timestamp into the local company day", () => {
    // 03:30 UTC on Aug 6 is still Aug 5 evening in Los Angeles.
    expect(dayKeyInTz("2026-08-06T03:30:00Z", "America/Los_Angeles")).toBe(
      "2026-08-05",
    );
    expect(dayKeyInTz("2026-08-06T03:30:00Z", "UTC")).toBe("2026-08-06");
  });

  it("handles timezones ahead of UTC", () => {
    // 22:00 UTC on Aug 5 is already Aug 6 in Auckland.
    expect(dayKeyInTz("2026-08-05T22:00:00Z", "Pacific/Auckland")).toBe(
      "2026-08-06",
    );
  });
});

describe("nextDayKey (DST boundaries)", () => {
  it("advances one civil day across the US spring-forward (23h day)", () => {
    // 2026-03-08 is spring-forward in America/New_York.
    expect(nextDayKey("2026-03-07")).toBe("2026-03-08");
    expect(nextDayKey("2026-03-08")).toBe("2026-03-09");
  });

  it("advances one civil day across the US fall-back (25h day)", () => {
    // 2026-11-01 is fall-back in America/New_York. A naive +24h from late in
    // the 25-hour day would still land on the same civil date.
    expect(nextDayKey("2026-11-01")).toBe("2026-11-02");
  });

  it("rolls over month and year ends", () => {
    expect(nextDayKey("2026-08-31")).toBe("2026-09-01");
    expect(nextDayKey("2026-12-31")).toBe("2027-01-01");
    expect(nextDayKey("2028-02-28")).toBe("2028-02-29"); // leap year
  });
});

describe("formatTimeInTz", () => {
  it("renders the company-local hour, not UTC", () => {
    expect(formatTimeInTz("2026-08-05T16:00:00Z", "America/Chicago")).toBe(
      "11:00 AM",
    );
  });
});

describe("company wall-clock conversion", () => {
  it("keeps the company-local calendar date when rescheduling across UTC midnight", () => {
    expect(
      isoToZonedInput("2026-08-06T06:30:00.000Z", "America/Los_Angeles"),
    ).toBe("2026-08-05T23:30");
    expect(zonedInputToIso("2026-08-06T00:15", "America/Los_Angeles")).toBe(
      "2026-08-06T07:15:00.000Z",
    );
  });

  it("converts a valid wall clock across spring-forward and rejects the gap", () => {
    expect(
      isoToZonedInput("2026-03-08T06:30:00.000Z", "America/New_York"),
    ).toBe("2026-03-08T01:30");
    expect(zonedInputToIso("2026-03-08T03:30", "America/New_York")).toBe(
      "2026-03-08T07:30:00.000Z",
    );
    expect(zonedInputToIso("2026-03-08T02:30", "America/New_York")).toBeNull();
  });

  it("resolves the repeated fall-back hour to the first (daylight) pass", () => {
    // 2026-11-01 is fall-back in America/New_York: clocks go from 1:59:59
    // EDT back to 1:00:00 EST, so "01:30" happens twice. We deterministically
    // take the earlier, still-daylight-saving pass (EDT, UTC-4) rather than
    // the later standard-time pass (EST, UTC-5) — matching the web
    // dashboard's zonedInputToIso so a reschedule saves the same instant no
    // matter which surface the owner used.
    expect(zonedInputToIso("2026-11-01T01:30", "America/New_York")).toBe(
      "2026-11-01T05:30:00.000Z",
    );
    // The wall clock immediately before the repeated hour (still EDT, only
    // one occurrence) and immediately after it (already EST, only one
    // occurrence) resolve unambiguously, bracketing the ambiguous hour.
    expect(zonedInputToIso("2026-11-01T00:30", "America/New_York")).toBe(
      "2026-11-01T04:30:00.000Z",
    );
    expect(zonedInputToIso("2026-11-01T02:30", "America/New_York")).toBe(
      "2026-11-01T07:30:00.000Z",
    );
    // Every wall-clock minute in the repeated hour round-trips back to
    // itself through isoToZonedInput, so the edit form and a reopened
    // detail screen always agree on what was saved.
    for (const wall of [
      "2026-11-01T01:00",
      "2026-11-01T01:30",
      "2026-11-01T01:59",
    ]) {
      const iso = zonedInputToIso(wall, "America/New_York");
      expect(iso).not.toBeNull();
      expect(isoToZonedInput(iso!, "America/New_York")).toBe(wall);
    }
  });
});

describe("formatDayFromKey", () => {
  it("labels the civil day without timezone drift", () => {
    expect(formatDayFromKey("2026-08-05")).toBe("Wed, Aug 5");
    expect(formatDayFromKey("2026-11-01")).toBe("Sun, Nov 1");
  });
});
