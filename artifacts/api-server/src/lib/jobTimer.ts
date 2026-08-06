/**
 * Turning clocked stretches into the numbers an owner bills from.
 *
 * The rules that matter here:
 *  - only finished stretches count toward `workedMinutes`. A running clock is
 *    reported as the instant it started, so the phone can tick the seconds and
 *    two devices watching the same job never disagree by a round trip.
 *  - each stretch is rounded to the nearest minute on its own, then summed, so
 *    the total always equals what the owner sees listed underneath it. Summing
 *    milliseconds and rounding at the end reads as an arithmetic error to the
 *    person reconciling the two.
 *  - a stretch that somehow ended before it started counts as zero rather than
 *    subtracting time from the job.
 */

export type TimeEntryRow = {
  id: number;
  startedAt: Date;
  endedAt: Date | null;
  startedByName: string | null;
  editedAt: Date | null;
};

export type SerializedTimeEntry = {
  id: number;
  startedAt: string;
  endedAt: string | null;
  minutes: number;
  startedByName: string | null;
  edited: boolean;
};

export type TimeSummary = {
  /** When the running stretch began; null when nothing is running. */
  timerRunningSince: string | null;
  /** Whole minutes across finished stretches only. */
  workedMinutes: number;
  timeEntries: SerializedTimeEntry[];
};

/** Whole minutes in a finished stretch, never negative. */
export function entryMinutes(entry: {
  startedAt: Date;
  endedAt: Date | null;
}): number {
  if (!entry.endedAt) return 0;
  const ms = entry.endedAt.getTime() - entry.startedAt.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(ms / 60_000);
}

export function summarizeTimeEntries(entries: TimeEntryRow[]): TimeSummary {
  const ordered = [...entries].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
  );
  let workedMinutes = 0;
  let runningSince: Date | null = null;

  for (const entry of ordered) {
    if (entry.endedAt) {
      workedMinutes += entryMinutes(entry);
    } else if (
      !runningSince ||
      entry.startedAt.getTime() > runningSince.getTime()
    ) {
      // The open-clock index allows only one of these, but if data ever gets
      // ahead of the constraint the most recent start is the honest answer.
      runningSince = entry.startedAt;
    }
  }

  return {
    timerRunningSince: runningSince ? runningSince.toISOString() : null,
    workedMinutes,
    timeEntries: ordered.map((entry) => ({
      id: entry.id,
      startedAt: entry.startedAt.toISOString(),
      endedAt: entry.endedAt ? entry.endedAt.toISOString() : null,
      minutes: entryMinutes(entry),
      startedByName: entry.startedByName,
      edited: entry.editedAt !== null,
    })),
  };
}

/** "2h 34m", "45m", "0m" — how long crew were on site, for people not machines. */
export function formatWorkedTime(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

/**
 * Worked minutes as billable hours, to one decimal. Quoting is hours x rate,
 * so this is what the owner drops into the calculator after reviewing the day.
 */
export function workedHours(minutes: number): number {
  return Math.round((Math.max(0, minutes) / 60) * 10) / 10;
}
