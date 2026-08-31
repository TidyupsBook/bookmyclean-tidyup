import { describe, it, expect } from "vitest";
import {
  zonedDayKey,
  zonedHour,
  weekdayIndex,
  weekdayShort,
  monthLabel,
  shiftMonth,
  threeDayDates,
  weekDates,
  monthGridDates,
  viewRange,
  daysBetween,
  groupByDay,
} from "./mapCalendar";

const EDMONTON = "America/Edmonton";

describe("company-zone placement", () => {
  // The whole reason this module exists: a late-evening job must land on the
  // company's day, not on whatever day the dispatcher's laptop thinks it is.
  it("puts a late-evening job on the company's day, not UTC's", () => {
    // 2026-08-07T04:00Z is 10pm on Aug 6 in Edmonton.
    expect(zonedDayKey("2026-08-07T04:00:00.000Z", EDMONTON)).toBe(
      "2026-08-06",
    );
    expect(zonedHour("2026-08-07T04:00:00.000Z", EDMONTON)).toBe(22);
  });

  it("reads half-hours as fractional hours", () => {
    expect(zonedHour("2026-08-06T15:30:00.000Z", EDMONTON)).toBe(9.5);
  });

  it("groups bookings into company-local days", () => {
    const grouped = groupByDay(
      [
        { scheduledFor: "2026-08-07T04:00:00.000Z", id: 1 },
        { scheduledFor: "2026-08-07T16:00:00.000Z", id: 2 },
      ],
      EDMONTON,
    );
    expect(Object.keys(grouped).sort()).toEqual(["2026-08-06", "2026-08-07"]);
    expect(grouped["2026-08-06"]?.[0]?.id).toBe(1);
  });
});

describe("weekday maths", () => {
  it("treats Sunday as the first day", () => {
    expect(weekdayIndex("2026-08-02")).toBe(0); // a Sunday
    expect(weekdayIndex("2026-08-08")).toBe(6); // the Saturday after
    expect(weekdayShort("2026-08-06")).toBe("Thu");
    expect(weekdayShort("2026-08-02")).toBe("Sun");
  });
});

describe("view ranges", () => {
  it("day view covers exactly one day", () => {
    const r = viewRange("day", "2026-08-06", "2026-08-01");
    expect(r).toEqual({
      start: "2026-08-06",
      end: "2026-08-06",
      dates: ["2026-08-06"],
    });
  });

  it("3-day view starts at the selected day", () => {
    expect(threeDayDates("2026-08-06")).toEqual([
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
    ]);
  });

  it("week view runs Sunday to Saturday around the selected day", () => {
    const week = weekDates("2026-08-06"); // a Thursday
    expect(week).toHaveLength(7);
    expect(week[0]).toBe("2026-08-02");
    expect(week[6]).toBe("2026-08-08");
  });

  it("month grid is whole weeks and contains the whole month", () => {
    const grid = monthGridDates("2026-08-01");
    expect(grid.length % 7).toBe(0);
    expect(weekdayIndex(grid[0]!)).toBe(0);
    expect(grid).toContain("2026-08-01");
    expect(grid).toContain("2026-08-31");
    // Padding days come from the neighbouring months.
    expect(grid[0]! < "2026-08-01").toBe(true);
  });

  it("month grid handles a month that starts on a Sunday", () => {
    const grid = monthGridDates("2026-11-01"); // Nov 1 2026 is a Sunday
    expect(grid[0]).toBe("2026-11-01");
    expect(grid.length % 7).toBe(0);
  });

  it("month grid handles a month that starts on a Saturday", () => {
    const grid = monthGridDates("2026-08-01"); // Aug 1 2026 is a Saturday
    expect(grid[0]).toBe("2026-07-26"); // padded back to the Sunday before
    expect(weekdayIndex(grid[grid.length - 1]!)).toBe(6); // ends on a Saturday
    expect(grid.length % 7).toBe(0);
  });

  it("month grid handles February in a leap year", () => {
    const grid = monthGridDates("2028-02-01");
    expect(grid).toContain("2028-02-29");
  });

  it("month view range spans the padded grid", () => {
    const r = viewRange("month", "2026-08-06", "2026-08-01");
    const grid = monthGridDates("2026-08-01");
    expect(r.start).toBe(grid[0]);
    expect(r.end).toBe(grid[grid.length - 1]);
  });
});

describe("navigation helpers", () => {
  it("steps months across a year boundary", () => {
    expect(shiftMonth("2026-12-01", 1)).toBe("2027-01-01");
    expect(shiftMonth("2026-01-15", -1)).toBe("2025-12-01");
  });

  it("labels a month", () => {
    expect(monthLabel("2026-08-06")).toBe("August 2026");
  });

  it("counts whole days across a DST change", () => {
    // Edmonton springs forward on 2026-03-08; the calendar still counts 7 days.
    expect(daysBetween("2026-03-05", "2026-03-12")).toBe(7);
  });
});
