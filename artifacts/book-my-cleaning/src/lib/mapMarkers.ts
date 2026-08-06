/**
 * Pure helpers for the Live Map. Kept free of React and the Google Maps SDK so
 * marker colour, initials, staleness and the "not yet located" split can be
 * unit-tested without a browser or a Maps key (which isn't authorized yet).
 */
import type { MapCleaner, MapJob } from "@workspace/api-client-react";

/** A cleaner's location older than this reads as "maybe a dead phone". */
export const STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * The colour drawn for a team member on the schedule and the map.
 *
 * A colour the owner picked on their staff card wins. Otherwise it falls back
 * to a stable hue derived from the id, so everybody has a distinct colour from
 * the moment they are added and nobody has to go and choose one — a hash into
 * a fixed hue wheel, kept at a saturation and lightness that stay legible on
 * the dark dashboard.
 *
 * Only a plain `#rrggbb` is honoured: the value lands in an inline style, and
 * the server stores nothing else, so anything odd falls back rather than being
 * painted into the page.
 */
export function colorForTeamMember(
  teamMemberId: number,
  chosen?: string | null,
): string {
  if (chosen && /^#[0-9a-fA-F]{6}$/.test(chosen.trim())) {
    return chosen.trim().toLowerCase();
  }
  // Golden-angle stepping spreads sequential ids far apart on the wheel.
  const hue = Math.abs(Math.round(teamMemberId * 137.508)) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

/**
 * The colours offered on a staff card. Ten hues that stay apart from each
 * other and readable on the dark dashboard, so a full crew can be told apart
 * at a glance on a month grid.
 */
/**
 * Two rows of swatches: a strong tone and a lighter version of the same hue.
 * Offices usually already have colours for their cleaners somewhere else
 * (Jobber, a whiteboard), and "the light pink one" has to be pickable here or
 * the two calendars never look like the same crew.
 */
export const STAFF_COLORS = [
  "#f472b6",
  "#e879f9",
  "#a78bfa",
  "#60a5fa",
  "#22d3ee",
  "#34d399",
  "#a3e635",
  "#fbbf24",
  "#fb923c",
  "#f87171",
  "#f9a8d4",
  "#f0abfc",
  "#c4b5fd",
  "#93c5fd",
  "#a5f3fc",
  "#6ee7b7",
  "#d9f99d",
  "#fde68a",
  "#fdba74",
  "#fca5a5",
] as const;

/** Up to two initials from a name, e.g. "Jane Doe" -> "JD", "Cher" -> "C". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return (
    parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)
  ).toUpperCase();
}

/** A cleaner is stale when we haven't heard from their phone in a while. */
export function isStale(updatedAt: string, now: number = Date.now()): boolean {
  const t = new Date(updatedAt).getTime();
  if (Number.isNaN(t)) return true;
  return now - t > STALE_AFTER_MS;
}

/** "just now", "3 min ago", "2 hr ago" — coarse and human, for the stale note. */
export function lastSeenLabel(
  updatedAt: string,
  now: number = Date.now(),
): string {
  const t = new Date(updatedAt).getTime();
  if (Number.isNaN(t)) return "never";
  const diffMs = now - t;
  if (diffMs < 60 * 1000) return "just now";
  const mins = Math.round(diffMs / (60 * 1000));
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** A coordinate is usable on the map only if it's a real, finite lat/lng. */
export function hasCoords(item: {
  lat?: number | null;
  lng?: number | null;
}): item is { lat: number; lng: number } {
  return (
    typeof item.lat === "number" &&
    typeof item.lng === "number" &&
    Number.isFinite(item.lat) &&
    Number.isFinite(item.lng) &&
    !(item.lat === 0 && item.lng === 0)
  );
}

/**
 * Split jobs into the ones we can plot and the ones we can't. A job with no
 * geocoded address must never silently vanish — it goes in the "not yet
 * located" list beside the map instead of breaking the marker loop.
 */
export function partitionJobsByCoords(jobs: MapJob[]): {
  located: MapJob[];
  unlocated: MapJob[];
} {
  const located: MapJob[] = [];
  const unlocated: MapJob[] = [];
  for (const job of jobs) {
    (hasCoords(job) ? located : unlocated).push(job);
  }
  return { located, unlocated };
}

/** Who's on a job, as a plain string for the info window / list. */
export function assigneeNames(job: MapJob): string {
  if (!job.assignees || job.assignees.length === 0) return "Unassigned";
  return job.assignees.map((a) => a.name).join(", ");
}

/** Cleaner accuracy, rounded, for the info window (metres). */
export function accuracyLabel(cleaner: MapCleaner): string | null {
  if (
    typeof cleaner.accuracy !== "number" ||
    !Number.isFinite(cleaner.accuracy)
  )
    return null;
  return `±${Math.round(cleaner.accuracy)} m`;
}
