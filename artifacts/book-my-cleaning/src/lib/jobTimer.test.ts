import { describe, it, expect } from "vitest";
import {
  elapsedSeconds,
  formatStopwatch,
  formatWorkedTime,
  totalMinutesSoFar,
  workedHours,
} from "./jobTimer";

const START = "2026-08-06T15:00:00.000Z";
const startMs = new Date(START).getTime();

describe("elapsedSeconds", () => {
  it("counts from the moment the stretch started", () => {
    expect(elapsedSeconds(START, startMs + 90_000)).toBe(90);
  });

  it("is nothing when no clock is running", () => {
    expect(elapsedSeconds(null, startMs)).toBe(0);
  });

  it("never runs backwards when the device clock is behind the server", () => {
    expect(elapsedSeconds(START, startMs - 60_000)).toBe(0);
  });

  it("ignores a start time it cannot read", () => {
    expect(elapsedSeconds("not a date", startMs)).toBe(0);
  });
});

describe("formatStopwatch", () => {
  it("reads like a stopwatch", () => {
    expect(formatStopwatch(0)).toBe("0:00");
    expect(formatStopwatch(62)).toBe("1:02");
    expect(formatStopwatch(3600)).toBe("1:00:00");
    expect(formatStopwatch(4442)).toBe("1:14:02");
  });
});

describe("formatWorkedTime", () => {
  it("says hours and minutes the way a person would", () => {
    expect(formatWorkedTime(154)).toBe("2h 34m");
    expect(formatWorkedTime(60)).toBe("1h");
    expect(formatWorkedTime(7)).toBe("7m");
    expect(formatWorkedTime(0)).toBe("0m");
  });
});

describe("totalMinutesSoFar", () => {
  it("includes the stretch still running", () => {
    expect(totalMinutesSoFar(60, START, startMs + 30 * 60_000)).toBe(90);
  });

  it("is just the banked time when the clock is stopped", () => {
    expect(totalMinutesSoFar(60, null, startMs)).toBe(60);
  });
});

describe("workedHours", () => {
  it("gives the quote calculator hours to one decimal", () => {
    expect(workedHours(154)).toBe(2.6);
    expect(workedHours(90)).toBe(1.5);
    expect(workedHours(0)).toBe(0);
  });
});
