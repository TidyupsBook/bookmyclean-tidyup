import { describe, expect, it } from "vitest";
import {
  dayKeyInTz,
  formatDayFromKey,
  formatDayInTz,
  formatTimeInTz,
  isValidTimeZone,
  nextDayKey,
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

describe("formatDayFromKey", () => {
  it("labels the civil day without timezone drift", () => {
    expect(formatDayFromKey("2026-08-05")).toBe("Wed, Aug 5");
    expect(formatDayFromKey("2026-11-01")).toBe("Sun, Nov 1");
  });
});
