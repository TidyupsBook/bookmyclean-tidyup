/**
 * All booking times are rendered in the COMPANY's timezone, never the
 * device's — the owner in the van must see the same hour the dispatcher
 * dashboard shows. There is deliberately NO fallback to device/UTC time:
 * an unusable company timezone must surface as an error state upstream
 * (see isValidTimeZone), because silently formatting in the wrong zone
 * would put jobs in the wrong day bucket.
 */

/** Screens must gate on this before calling the formatters below. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function dayKeyInTz(iso: string | Date, timeZone: string): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function formatTimeInTz(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function formatDayInTz(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

/**
 * Advance a `YYYY-MM-DD` day key by one civil calendar day. Operating on the
 * calendar date (not `+24h` on a timestamp) keeps DST transitions correct:
 * the day after a 23-hour or 25-hour day is still the next calendar date.
 */
export function nextDayKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Human label ("Wed, Aug 5") for a `YYYY-MM-DD` civil day key. */
export function formatDayFromKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d)));
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

/** ISO instant -> `YYYY-MM-DDTHH:mm` wall clock in the given zone. */
export function isoToZonedInput(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() + zoneOffsetMs(d, timeZone))
    .toISOString()
    .slice(0, 16);
}

/**
 * `YYYY-MM-DDTHH:mm` wall clock in the COMPANY's zone -> ISO instant.
 *
 * Same contract as the web dashboard's helper: returns null for a wall
 * clock that never happens in that zone (the spring-forward gap), so a
 * booking is never silently slid to a neighbouring hour. In the repeated
 * autumn hour, which is genuinely ambiguous, we deterministically take the
 * first (still-daylight-saving) pass — the two-pass offset resolution below
 * always converges on the pre-transition offset for a wall clock that
 * exists twice. This must stay in lockstep with the web dashboard's
 * zonedInputToIso, or the same reschedule would save a different instant
 * depending on which surface the owner used.
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

  const iso = instant.toISOString();
  if (isoToZonedInput(iso, timeZone) !== wallClock.slice(0, 16)) return null;
  return iso;
}

export function formatMoney(amount: number): string {
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}
