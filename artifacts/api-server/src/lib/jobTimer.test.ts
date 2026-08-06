import { describe, it, expect } from "vitest";
import {
  entryMinutes,
  summarizeTimeEntries,
  formatWorkedTime,
  workedHours,
  type TimeEntryRow,
} from "./jobTimer";

function row(over: Partial<TimeEntryRow> & { id: number }): TimeEntryRow {
  return {
    startedAt: new Date("2026-08-06T15:00:00Z"),
    endedAt: null,
    startedByName: null,
    editedAt: null,
    ...over,
  };
}

describe("entryMinutes", () => {
  it("rounds a finished stretch to the nearest minute", () => {
    expect(
      entryMinutes({
        startedAt: new Date("2026-08-06T15:00:00Z"),
        endedAt: new Date("2026-08-06T16:32:40Z"),
      }),
    ).toBe(93);
  });

  it("counts a running stretch as nothing yet", () => {
    expect(
      entryMinutes({
        startedAt: new Date("2026-08-06T15:00:00Z"),
        endedAt: null,
      }),
    ).toBe(0);
  });

  it("refuses to subtract time when the clock ran backwards", () => {
    expect(
      entryMinutes({
        startedAt: new Date("2026-08-06T16:00:00Z"),
        endedAt: new Date("2026-08-06T15:00:00Z"),
      }),
    ).toBe(0);
  });
});

describe("summarizeTimeEntries", () => {
  it("adds up finished stretches and reports the running one separately", () => {
    const summary = summarizeTimeEntries([
      row({
        id: 1,
        startedAt: new Date("2026-08-06T15:00:00Z"),
        endedAt: new Date("2026-08-06T16:00:00Z"),
      }),
      row({ id: 2, startedAt: new Date("2026-08-06T16:30:00Z") }),
    ]);

    expect(summary.workedMinutes).toBe(60);
    expect(summary.timerRunningSince).toBe("2026-08-06T16:30:00.000Z");
    expect(summary.timeEntries.map((e) => e.minutes)).toEqual([60, 0]);
  });

  it("keeps the listed stretches adding up to the total", () => {
    const summary = summarizeTimeEntries([
      row({
        id: 1,
        startedAt: new Date("2026-08-06T15:00:00Z"),
        endedAt: new Date("2026-08-06T15:20:30Z"),
      }),
      row({
        id: 2,
        startedAt: new Date("2026-08-06T15:40:00Z"),
        endedAt: new Date("2026-08-06T16:00:30Z"),
      }),
    ]);

    const listed = summary.timeEntries.reduce((sum, e) => sum + e.minutes, 0);
    expect(listed).toBe(summary.workedMinutes);
  });

  it("orders stretches oldest first whatever order they arrive in", () => {
    const summary = summarizeTimeEntries([
      row({
        id: 2,
        startedAt: new Date("2026-08-06T17:00:00Z"),
        endedAt: new Date("2026-08-06T17:30:00Z"),
      }),
      row({
        id: 1,
        startedAt: new Date("2026-08-06T15:00:00Z"),
        endedAt: new Date("2026-08-06T15:30:00Z"),
      }),
    ]);
    expect(summary.timeEntries.map((e) => e.id)).toEqual([1, 2]);
  });

  it("reports no clock running when every stretch is finished", () => {
    const summary = summarizeTimeEntries([
      row({
        id: 1,
        startedAt: new Date("2026-08-06T15:00:00Z"),
        endedAt: new Date("2026-08-06T15:30:00Z"),
      }),
    ]);
    expect(summary.timerRunningSince).toBeNull();
  });

  it("has nothing to say about a job nobody has clocked on to", () => {
    expect(summarizeTimeEntries([])).toEqual({
      timerRunningSince: null,
      workedMinutes: 0,
      timeEntries: [],
    });
  });

  it("marks hand-corrected stretches so the owner can tell them apart", () => {
    const summary = summarizeTimeEntries([
      row({
        id: 1,
        startedAt: new Date("2026-08-06T15:00:00Z"),
        endedAt: new Date("2026-08-06T15:30:00Z"),
        editedAt: new Date("2026-08-06T18:00:00Z"),
      }),
    ]);
    expect(summary.timeEntries[0]!.edited).toBe(true);
  });
});

describe("formatWorkedTime", () => {
  it("reads the way someone would say it", () => {
    expect(formatWorkedTime(154)).toBe("2h 34m");
    expect(formatWorkedTime(45)).toBe("45m");
    expect(formatWorkedTime(120)).toBe("2h");
    expect(formatWorkedTime(0)).toBe("0m");
  });
});

describe("workedHours", () => {
  it("gives billable hours to one decimal", () => {
    expect(workedHours(154)).toBe(2.6);
    expect(workedHours(30)).toBe(0.5);
    expect(workedHours(0)).toBe(0);
  });
});
