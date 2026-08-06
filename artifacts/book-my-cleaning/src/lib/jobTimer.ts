/**
 * Showing clocked time on a job card.
 *
 * The server reports two things: minutes already banked from finished
 * stretches, and the instant the current stretch started (null when nothing is
 * running). The ticking part is worked out here from the wall clock, so the
 * seconds move without a request per second and two phones watching the same
 * job never disagree by a round trip.
 */

/** Seconds elapsed since a stretch started. Never negative, even if the device's clock is behind. */
export function elapsedSeconds(
  runningSince: string | null,
  now: number,
): number {
  if (!runningSince) return 0;
  const started = new Date(runningSince).getTime();
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.floor((now - started) / 1000));
}

/** "14:02" under an hour, "1:14:02" over it — how a stopwatch reads. */
export function formatStopwatch(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return `${hours > 0 ? `${hours}:` : ""}${mm}:${String(seconds).padStart(2, "0")}`;
}

/** "2h 34m", "45m", "0m" — for time already banked. */
export function formatWorkedTime(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

/**
 * Everything clocked on the job so far, including the stretch still running.
 * This is the number an owner reads when deciding what to bill mid-job.
 */
export function totalMinutesSoFar(
  workedMinutes: number,
  runningSince: string | null,
  now: number,
): number {
  return (
    Math.max(0, workedMinutes) +
    Math.floor(elapsedSeconds(runningSince, now) / 60)
  );
}

/** Billable hours to one decimal, the unit the quote calculator works in. */
export function workedHours(minutes: number): number {
  return Math.round((Math.max(0, minutes) / 60) * 10) / 10;
}

/**
 * Minutes that were clocked in Jobber's own timer rather than here.
 *
 * Worth calling out on the card: an owner who sees three hours on a job nobody
 * pressed Start for should be told where the time came from, not left assuming
 * the app invented it.
 */
export function jobberMinutes(
  entries: Array<{ minutes?: number; source?: string }> | null | undefined,
): number {
  if (!entries) return 0;
  return entries
    .filter((entry) => entry.source === "jobber")
    .reduce((sum, entry) => sum + Math.max(0, entry.minutes ?? 0), 0);
}
