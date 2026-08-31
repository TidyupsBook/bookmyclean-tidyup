/**
 * Who may watch the crew's live positions, and when.
 *
 * The owner may watch at any hour, from any of his devices — the map is his
 * to look at and the whole point of the Live Map is that he can open it from a
 * phone at 11pm. Every non-owner may watch only during working hours, so
 * "where is everybody" is a dispatch tool rather than a standing window into
 * where an employee is on their own time.
 *
 * The window is resolved in the COMPANY's timezone, never the viewer's
 * browser clock — a dispatcher travelling, or a machine with the wrong zone,
 * must not be able to move the boundary. And the decision is made here, on
 * the server, so a withheld payload is genuinely absent rather than filtered
 * out of a response that still carried it.
 *
 */
import type { CallerRole } from "./callerRole";
import { zoneOffsetMs } from "./timezoneReview";

/** Dispatch may watch from 8:00am… */
export const DISPATCH_WATCH_START_HOUR = 8;
/** …until 8:00pm, company time. */
export const DISPATCH_WATCH_END_HOUR = 20;

export type LivePositionAccess = {
  allowed: boolean;
  /** Ready to render. Null when allowed. */
  reason: string | null;
};

/** The wall-clock hour (0-23) in a timezone at a given instant. */
export function hourInZone(at: Date, timeZone: string): number {
  // Shift the instant by the zone's offset and read it back as UTC, so the
  // arithmetic matches dayBounds' notion of local time exactly.
  const shifted = new Date(at.getTime() + zoneOffsetMs(at, timeZone));
  return shifted.getUTCHours();
}

/** "8:00am" / "8:00pm" from a 24-hour hour, for the withheld-reason text. */
function clockLabel(hour24: number): string {
  const suffix = hour24 >= 12 ? "pm" : "am";
  const h = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${h}:00${suffix}`;
}

/**
 * May this caller see live positions right now?
 *
 * @param role   the resolved caller's role
 * @param company the company being looked at, for its timezone
 * @param now    the instant to judge; injectable so tests can stand at 9pm
 */
export function livePositionAccess(
  role: CallerRole,
  company: { timezone: string },
  now: Date = new Date(),
): LivePositionAccess {
  if (role === "owner") return { allowed: true, reason: null };

  const hour = hourInZone(now, company.timezone);
  if (hour >= DISPATCH_WATCH_START_HOUR && hour < DISPATCH_WATCH_END_HOUR) {
    return { allowed: true, reason: null };
  }
  return {
    allowed: false,
    reason:
      `Live locations are only shown between ` +
      `${clockLabel(DISPATCH_WATCH_START_HOUR)} and ${clockLabel(DISPATCH_WATCH_END_HOUR)} ` +
      `company time. They'll be back at ${clockLabel(DISPATCH_WATCH_START_HOUR)}.`,
  };
}
