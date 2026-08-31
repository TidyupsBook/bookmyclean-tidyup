/**
 * Which job a cleaner is heading to right now.
 *
 * Deliberately a pure function over the day's candidates so the rule is
 * testable and identical everywhere it is asked: the earliest of today's
 * still-relevant jobs that the map can actually point at.
 *
 * "Still relevant" means the job's expected window hasn't fully passed — a
 * 10 AM job is still the destination at 10:20 (they're running late or on
 * site), but not at 4 PM. A booking nobody marked completed must eventually
 * stop being "next", or the trail would point backwards all afternoon.
 */

/** A booking with no duration is assumed to take this long. */
export const DEFAULT_JOB_MINUTES = 120;

type CandidateJob = {
  id: number;
  scheduledFor: Date;
  durationMinutes: number | null;
  lat: number | null;
  lng: number | null;
  status: string;
};

export function pickNextJob<T extends CandidateJob>(
  jobs: T[],
  now: Date,
): T | null {
  const nowMs = now.getTime();
  const eligible = jobs.filter((job) => {
    // Completed and canceled work is never a destination.
    if (job.status !== "pending" && job.status !== "confirmed") return false;
    // A job we can't place on the map can't have a trail drawn to it.
    if (job.lat === null || job.lng === null) return false;
    const windowMs = (job.durationMinutes ?? DEFAULT_JOB_MINUTES) * 60_000;
    return nowMs < job.scheduledFor.getTime() + windowMs;
  });
  eligible.sort(
    (a, b) =>
      a.scheduledFor.getTime() - b.scheduledFor.getTime() || a.id - b.id,
  );
  return eligible[0] ?? null;
}
