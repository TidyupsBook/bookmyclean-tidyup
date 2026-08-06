/**
 * Booking times are shown and edited in the *company's* timezone, never the
 * browser's. A dispatcher working from another city (or a VA overseas) must see
 * the same hour the customer gets texted — otherwise we quote the wrong time.
 *
 * Built on Intl so it needs no extra dependency.
 */

const FALLBACK_TZ = "America/Edmonton";

export function companyTimeZone(
  company: { timezone?: string | null } | undefined | null,
): string {
  return company?.timezone || FALLBACK_TZ;
}

/** How far the zone is from UTC at a given instant, in ms (DST-aware). */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - date.getTime();
}

/** ISO instant -> `YYYY-MM-DDTHH:mm` wall clock for a `datetime-local` input. */
export function isoToZonedInput(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() + zoneOffsetMs(d, timeZone))
    .toISOString()
    .slice(0, 16);
}

/**
 * `YYYY-MM-DDTHH:mm` wall clock in the given zone -> ISO instant.
 *
 * Returns null for a time that does not exist in that zone — the hour skipped
 * by the spring-forward change. Silently sliding such a value to a neighbouring
 * hour would schedule the customer at a time nobody agreed to, so the caller is
 * made to deal with it. In the repeated autumn hour, which is genuinely
 * ambiguous, we deterministically take the first (still-daylight-saving) pass.
 */
export function zonedInputToIso(
  wallClock: string,
  timeZone: string,
): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wallClock);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as unknown as number[];
  const naive = Date.UTC(y!, mo! - 1, d!, h!, mi!);

  // Two passes so instants near a DST boundary settle on the right offset.
  let instant = new Date(naive - zoneOffsetMs(new Date(naive), timeZone));
  instant = new Date(naive - zoneOffsetMs(instant, timeZone));
  if (Number.isNaN(instant.getTime())) return null;

  // If it doesn't render back as the wall clock we were given, that wall clock
  // never happens in this zone.
  const iso = instant.toISOString();
  if (isoToZonedInput(iso, timeZone) !== wallClock.slice(0, 16)) return null;
  return iso;
}

/** e.g. "Saturday, August 8, 2026 at 10:00 AM" — in the company's zone. */
export function formatZoned(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
    .format(d)
    .replace(/,\s(\d{1,2}:\d{2})/, " at $1");
}

/** Short zone label for the UI, e.g. "MDT". */
export function zoneLabel(timeZone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "short",
  }).formatToParts(at);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? timeZone;
}

/** Today in the company's zone, as a `YYYY-MM-DD` date-input value. */
export function todayInZone(timeZone: string): string {
  return isoToZonedInput(new Date().toISOString(), timeZone).slice(0, 10);
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/**
 * Turns what the caller said about timing — "today", "tomorrow", "next
 * Tuesday" — into a real date in the company's zone, for the date box on the
 * booking desk.
 *
 * Returns null for anything vaguer than a specific day ("sometime next week",
 * "after the long weekend"). A vague phrase left in the notes gets asked
 * about; a wrong date gets a crew sent out on the wrong morning.
 *
 * A weekday name always means the *next* one — "Tuesday" said on a Tuesday is
 * the Tuesday coming, not today.
 */
export function resolveSpokenDate(
  phrase: string | null | undefined,
  timeZone: string,
): string | null {
  if (!phrase) return null;
  const text = phrase.toLowerCase();
  const today = todayInZone(timeZone);
  const [y, m, d] = today.split("-").map(Number);
  const base = Date.UTC(y!, m! - 1, d!);
  const shift = (days: number) =>
    new Date(base + days * 86400000).toISOString().slice(0, 10);

  if (/\btoday\b/.test(text)) return today;
  if (/\btomorrow\b/.test(text)) return shift(1);

  const weekday = WEEKDAYS.findIndex((name) =>
    new RegExp(`\\b${name}\\b`).test(text),
  );
  if (weekday === -1) return null;

  const todayIndex = new Date(base).getUTCDay();
  let ahead = (weekday - todayIndex + 7) % 7;
  if (ahead === 0) ahead = 7;
  // "next Tuesday" said early in the week usually means the week after.
  if (/\bnext\b/.test(text) && ahead < 7 && todayIndex <= weekday) ahead += 7;
  return shift(ahead);
}

/** Tomorrow at 9am in the company's zone, as a `datetime-local` value. */
export function defaultScheduledFor(timeZone: string): string {
  const now = new Date();
  const todayThere = isoToZonedInput(now.toISOString(), timeZone).slice(0, 10);
  const [y, m, d] = todayThere.split("-").map(Number);
  const tomorrow = new Date(Date.UTC(y!, m! - 1, d! + 1));
  return `${tomorrow.toISOString().slice(0, 10)}T09:00`;
}
