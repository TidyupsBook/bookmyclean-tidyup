import { zoneOffsetMs } from "./timezoneReview";

/**
 * The UTC instants that bound a calendar day in a company's timezone.
 *
 * Day boundaries MUST be computed in the company's zone, never the server's or
 * the browser's — a booking at 11pm local belongs to that local day, and the
 * server may sit in an entirely different zone. Reuses the same DST-aware
 * offset logic that the timezone-review flow relies on so "which day is this"
 * is answered one way across the API.
 *
 * `dateStr` is YYYY-MM-DD; anything else (or omitted) falls back to today in
 * the company's zone. Returns [start, end) as a half-open range so a query is
 * `>= start AND < end`.
 */
export function companyDayBounds(
  dateStr: string | undefined,
  timeZone: string,
): { start: Date; end: Date; date: string } {
  const date = normalizeDate(dateStr, timeZone);
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];

  // Midnight local, expressed as a UTC instant. We take midnight-as-if-UTC,
  // then shift by the zone's offset at that instant to land on true local
  // midnight. Recomputing the offset at the shifted instant handles days where
  // the offset at 00:00 UTC differs from the offset at local midnight.
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const startMs = guess - zoneOffsetMs(new Date(guess), timeZone);
  const start = new Date(startMs);
  const endGuess = Date.UTC(year, month - 1, day + 1, 0, 0, 0);
  const end = new Date(endGuess - zoneOffsetMs(new Date(endGuess), timeZone));
  return { start, end, date };
}

/**
 * The first day the bookings list is allowed to show.
 *
 * Everything scheduled before this date is Jobber-era history: it was pulled
 * in from Jobber during the migration and belongs in Jobber, not in this app's
 * job list. The floor is a display/read rule only — those rows are still
 * stored, still syncable, and still reachable by direct link — so it lives
 * here next to the day-bounds helper rather than in the sync code.
 */
export const BOOKING_HISTORY_FLOOR_DATE = "2026-08-01";

/**
 * The history floor as a UTC instant, anchored to the company's own midnight.
 *
 * A job at 11pm on July 31 local stays out and 12:01am on August 1 local stays
 * in, whichever zone the viewer's browser happens to be in — the same
 * company-timezone rule every other "which day is this" answer uses.
 */
export function bookingHistoryFloor(timeZone: string): Date {
  return companyDayBounds(BOOKING_HISTORY_FLOOR_DATE, timeZone).start;
}

/** Today's YYYY-MM-DD in the given zone. */
function normalizeDate(dateStr: string | undefined, timeZone: string): string {
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
