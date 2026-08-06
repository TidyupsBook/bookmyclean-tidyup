import { afterEach, describe, expect, it, vi } from "vitest";
import { isoToZonedInput, resolveSpokenDate, zonedInputToIso } from "./time";

// 2026 US DST: spring forward Sun Mar 8 (02:00→03:00), fall back Sun Nov 1.
const DENVER = "America/Denver";
const PHOENIX = "America/Phoenix";

describe("zonedInputToIso", () => {
  it("converts a standard-time wall clock (MST, UTC-7)", () => {
    expect(zonedInputToIso("2026-01-15T09:00", DENVER)).toBe(
      "2026-01-15T16:00:00.000Z",
    );
  });

  it("converts a daylight-time wall clock (MDT, UTC-6)", () => {
    expect(zonedInputToIso("2026-07-15T09:00", DENVER)).toBe(
      "2026-07-15T15:00:00.000Z",
    );
  });

  it("returns null for the nonexistent spring-forward hour", () => {
    expect(zonedInputToIso("2026-03-08T02:30", DENVER)).toBeNull();
    expect(zonedInputToIso("2026-03-08T02:00", DENVER)).toBeNull();
  });

  it("accepts times just outside the skipped hour", () => {
    expect(zonedInputToIso("2026-03-08T01:59", DENVER)).toBe(
      "2026-03-08T08:59:00.000Z",
    );
    expect(zonedInputToIso("2026-03-08T03:00", DENVER)).toBe(
      "2026-03-08T09:00:00.000Z",
    );
  });

  it("keeps the spring-forward hour valid in a zone without DST", () => {
    // Phoenix never springs forward, so 02:30 exists there.
    expect(zonedInputToIso("2026-03-08T02:30", PHOENIX)).toBe(
      "2026-03-08T09:30:00.000Z",
    );
  });

  it("resolves the ambiguous fall-back hour to the first (daylight) pass", () => {
    // 01:30 happens twice on Nov 1 2026 in Denver; we take MDT (UTC-6).
    expect(zonedInputToIso("2026-11-01T01:30", DENVER)).toBe(
      "2026-11-01T07:30:00.000Z",
    );
  });

  it("rejects malformed input", () => {
    expect(zonedInputToIso("not-a-time", DENVER)).toBeNull();
  });
});

describe("isoToZonedInput", () => {
  it("round-trips with zonedInputToIso in both DST halves of the year", () => {
    for (const wall of [
      "2026-01-15T09:00",
      "2026-07-15T09:00",
      "2026-03-08T03:30",
    ]) {
      const iso = zonedInputToIso(wall, DENVER);
      expect(iso).not.toBeNull();
      expect(isoToZonedInput(iso!, DENVER)).toBe(wall);
    }
  });

  it("renders the same instant differently across zones only when offsets differ", () => {
    // Winter: Denver (MST) and Phoenix agree at UTC-7.
    expect(isoToZonedInput("2026-01-15T16:00:00.000Z", DENVER)).toBe(
      isoToZonedInput("2026-01-15T16:00:00.000Z", PHOENIX),
    );
    // Summer: Denver is UTC-6, Phoenix stays UTC-7 → one hour apart.
    expect(isoToZonedInput("2026-07-15T15:00:00.000Z", DENVER)).toBe(
      "2026-07-15T09:00",
    );
    expect(isoToZonedInput("2026-07-15T15:00:00.000Z", PHOENIX)).toBe(
      "2026-07-15T08:00",
    );
  });

  it("returns empty string for an invalid ISO", () => {
    expect(isoToZonedInput("garbage", DENVER)).toBe("");
  });
});

describe("resolveSpokenDate", () => {
  afterEach(() => vi.useRealTimers());

  /** Freeze the clock at an instant, expressed in UTC. */
  function at(iso: string) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
  }

  it("turns today and tomorrow into real dates in the company's zone", () => {
    at("2026-08-06T18:00:00.000Z"); // Thursday, noon in Denver
    expect(resolveSpokenDate("today please", DENVER)).toBe("2026-08-06");
    expect(resolveSpokenDate("tomorrow morning", DENVER)).toBe("2026-08-07");
  });

  it("uses the company's day, not the browser's", () => {
    // 01:00 UTC Friday is still 19:00 Thursday in Denver.
    at("2026-08-07T01:00:00.000Z");
    expect(resolveSpokenDate("today", DENVER)).toBe("2026-08-06");
  });

  it("reads a weekday as the next one coming", () => {
    at("2026-08-06T18:00:00.000Z"); // Thursday
    expect(resolveSpokenDate("friday if you can", DENVER)).toBe("2026-08-07");
    expect(resolveSpokenDate("monday", DENVER)).toBe("2026-08-10");
  });

  it("never reads a weekday as today", () => {
    at("2026-08-06T18:00:00.000Z"); // Thursday
    expect(resolveSpokenDate("thursday", DENVER)).toBe("2026-08-13");
  });

  it("pushes 'next' a week out when the day is still ahead this week", () => {
    at("2026-08-03T18:00:00.000Z"); // Monday
    expect(resolveSpokenDate("this wednesday", DENVER)).toBe("2026-08-05");
    expect(resolveSpokenDate("next wednesday", DENVER)).toBe("2026-08-12");
  });

  it("gives up on anything vaguer than a day", () => {
    at("2026-08-06T18:00:00.000Z");
    for (const phrase of [
      "sometime next week",
      "after the long weekend",
      "whenever you're free",
      null,
      "",
    ]) {
      expect(resolveSpokenDate(phrase, DENVER)).toBeNull();
    }
  });
});
