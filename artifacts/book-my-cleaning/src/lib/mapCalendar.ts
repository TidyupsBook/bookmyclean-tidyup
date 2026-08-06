/**
 * Date maths for the live map's calendar views (day / 3-day / week / month).
 *
 * Everything here works on `YYYY-MM-DD` strings rather than `Date` objects.
 * That is deliberate: a `Date` carries the *browser's* timezone, and a
 * dispatcher working from another city would otherwise see a job slide into
 * the wrong column. Calendar squares are labels, not instants — the only place
 * a real instant matters is placing a booking in a column, which goes through
 * the company's timezone explicitly.
 */
import { isoToZonedInput } from "./time";
import { shiftDay } from "./schedule";

export type CalendarView = "day" | "3day" | "week" | "month";

/** Hours the grid draws. Cleaning work doesn't start at 3am. */
export const GRID_START_HOUR = 7;
export const GRID_END_HOUR = 20;

const DAY_MS = 86_400_000;

/** Which day a booking falls on, in the company's zone. */
export function zonedDayKey(iso: string, timeZone: string): string {
  return isoToZonedInput(iso, timeZone).slice(0, 10);
}

/** Fractional hour in the company's zone — 9.5 means 9:30. */
export function zonedHour(iso: string, timeZone: string): number {
  const wall = isoToZonedInput(iso, timeZone);
  const match = /T(\d{2}):(\d{2})$/.exec(wall);
  if (!match) return GRID_START_HOUR;
  return Number(match[1]) + Number(match[2]) / 60;
}

/** "9:30 AM" in the company's zone — the label on a calendar block. */
export function zonedClock(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

/** Monday = 0 … Sunday = 6, for a YYYY-MM-DD string. */
export function weekdayIndex(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  // Noon avoids any chance of a UTC rounding edge.
  const js = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return (js + 6) % 7;
}

/** "Mon", "Tue", … for a YYYY-MM-DD string. */
export function weekdayShort(date: string): string {
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][
    weekdayIndex(date)
  ] as string;
}

/** The day-of-month number as a string, with no leading zero. */
export function dayNumber(date: string): string {
  return String(Number(date.slice(8, 10)));
}

/** "August 2026" from a YYYY-MM-DD anchor. */
export function monthLabel(date: string): string {
  const [y, m] = date.split("-").map(Number) as [number, number];
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** "Wed, Aug 6" — the compact label above the map. */
export function shortDayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Step a month anchor by whole months, clamping to the 1st. */
export function shiftMonth(date: string, delta: number): string {
  const [y, m] = date.split("-").map(Number) as [number, number];
  const total = y * 12 + (m - 1) + delta;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}

/** The three days starting at the selected one. */
export function threeDayDates(date: string): string[] {
  return [0, 1, 2].map((i) => shiftDay(date, i));
}

/** Monday-to-Sunday week containing the given date. */
export function weekDates(date: string): string[] {
  const monday = shiftDay(date, -weekdayIndex(date));
  return Array.from({ length: 7 }, (_, i) => shiftDay(monday, i));
}

/**
 * The full month grid, padded to whole Monday-start weeks. Always returns a
 * multiple of 7 so the grid never has a ragged last row.
 */
export function monthGridDates(anchor: string): string[] {
  const first = `${anchor.slice(0, 7)}-01`;
  const gridStart = shiftDay(first, -weekdayIndex(first));
  const [y, m] = anchor.split("-").map(Number) as [number, number];
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = `${anchor.slice(0, 7)}-${String(daysInMonth).padStart(2, "0")}`;
  const gridEnd = shiftDay(last, 6 - weekdayIndex(last));

  const dates: string[] = [];
  for (let d = gridStart; d <= gridEnd; d = shiftDay(d, 1)) dates.push(d);
  return dates;
}

/**
 * Which days a view covers, and therefore what the map should pin. The day
 * view is a single day; the others show every job in the visible span so the
 * map matches the calendar sitting above it.
 */
export function viewRange(
  view: CalendarView,
  selectedDate: string,
  monthAnchor: string,
): { start: string; end: string; dates: string[] } {
  if (view === "3day") {
    const dates = threeDayDates(selectedDate);
    return { start: dates[0]!, end: dates[dates.length - 1]!, dates };
  }
  if (view === "week") {
    const dates = weekDates(selectedDate);
    return { start: dates[0]!, end: dates[dates.length - 1]!, dates };
  }
  if (view === "month") {
    const dates = monthGridDates(monthAnchor);
    return { start: dates[0]!, end: dates[dates.length - 1]!, dates };
  }
  return { start: selectedDate, end: selectedDate, dates: [selectedDate] };
}

/** Whole days between two YYYY-MM-DD strings. */
export function daysBetween(start: string, end: string): number {
  const toMs = (s: string) => {
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toMs(end) - toMs(start)) / DAY_MS);
}

/** Group anything with a `scheduledFor` by its company-local day. */
export function groupByDay<T extends { scheduledFor: string }>(
  items: T[],
  timeZone: string,
): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) {
    const key = zonedDayKey(item.scheduledFor, timeZone);
    (out[key] ??= []).push(item);
  }
  return out;
}
