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

/**
 * The boss's colour. Every device belonging to the company owner is painted
 * this regardless of the colour on their roster card — the whole point of the
 * request was that the owner is unmistakable among the crew, and a colour he
 * picked for himself months ago can't be trusted to stand out.
 *
 * Bright yellow on a light map needs help to stay readable, so it travels with
 * a dark ink for its label and a dark outline instead of the white ring the
 * other markers wear. Those go together — the yellow alone on white is close
 * to invisible.
 */
export const OWNER_MARKER_COLOR = "#facc15";
/** Label text on an owner marker: dark, because yellow can't carry white. */
export const OWNER_MARKER_INK = "#3f2d00";
/** The ring around an owner marker, so the disc has an edge on a pale map. */
export const OWNER_MARKER_OUTLINE = "#a16207";

export type MarkerStyle = {
  /** Disc fill. */
  fill: string;
  /** Text drawn ON the fill (the car glyph, the initials tag's border). */
  ink: string;
  /** The ring around the disc. */
  outline: string;
};

/**
 * How to paint one device's marker. Owner devices force the high-visibility
 * yellow; everybody else keeps the roster colour they've always had.
 *
 * Live and stale share the styling — the stale state is expressed by opacity
 * at the call site, so a dimmed owner car is still yellow and still outlined
 * rather than fading into the map.
 */
export function markerStyleFor(cleaner: {
  teamMemberId: number;
  color?: string | null;
  isOwner?: boolean | null;
}): MarkerStyle {
  if (cleaner.isOwner) {
    return {
      fill: OWNER_MARKER_COLOR,
      ink: OWNER_MARKER_INK,
      outline: OWNER_MARKER_OUTLINE,
    };
  }
  const fill = colorForTeamMember(cleaner.teamMemberId, cleaner.color);
  return { fill, ink: "#ffffff", outline: "#ffffff" };
}

/**
 * The device name to show on a marker, or null to leave it off.
 *
 * Only shown when the person actually has more than one device on the map: a
 * cleaner with a single phone doesn't need "Phone" written under their car,
 * but the owner's four pins are meaningless without "Boss PC" / "iPad" telling
 * them apart.
 */
export function deviceLabelFor(
  cleaner: { teamMemberId: number; deviceLabel?: string | null },
  all: Array<{ teamMemberId: number }>,
): string | null {
  const label = cleaner.deviceLabel?.trim();
  if (!label) return null;
  const devices = all.filter(
    (c) => c.teamMemberId === cleaner.teamMemberId,
  ).length;
  return devices > 1 ? label : null;
}

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

/** A marker/chip fill as 0..255 rgb, from #rrggbb or the hsl() fallback. */
function rgbOf(color: string): { r: number; g: number; b: number } | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const hsl = /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i.exec(
    color.trim(),
  );
  if (hsl) {
    const h = ((parseFloat(hsl[1]!) % 360) + 360) % 360;
    const s = Math.min(100, parseFloat(hsl[2]!)) / 100;
    const l = Math.min(100, parseFloat(hsl[3]!)) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const [r, g, b] =
      h < 60
        ? [c, x, 0]
        : h < 120
          ? [x, c, 0]
          : h < 180
            ? [0, c, x]
            : h < 240
              ? [0, x, c]
              : h < 300
                ? [x, 0, c]
                : [c, 0, x];
    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255),
    };
  }
  return null;
}

/**
 * The ink that stays readable on a given fill. Half the roster palette is
 * pastel — white initials on `#fde68a` disappear — so anything that writes on
 * a team colour must pick its ink from the colour, not assume white.
 */
export function inkFor(fill: string): string {
  const rgb = rgbOf(fill);
  if (!rgb) return "#ffffff";
  const luma = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luma >= 0.6 ? "#1f2937" : "#ffffff";
}

/** One little disc riding a job pin: who, in their own colour. */
export type CrewChip = {
  initials: string;
  name: string;
  color: string;
  /** Text colour that survives a pastel fill. */
  ink: string;
};

/**
 * The crew badges a job pin wears, so "who is on this job" is readable
 * without opening the info window. Capped — a pin can only carry so many
 * discs before it covers the street it points at — with the overflow count
 * returned so the pin can say "+2" instead of silently dropping people.
 *
 * Colours go through the same `colorForTeamMember` mapping as the cars and
 * trails, so the disc on the pin and the car driving toward it match.
 */
export function crewChipsFor(
  job: Pick<MapJob, "assignees">,
  max = 3,
): { chips: CrewChip[]; extra: number } {
  const assignees = job.assignees ?? [];
  const chips = assignees.slice(0, max).map((a) => {
    const color = colorForTeamMember(a.teamMemberId, a.color);
    return {
      initials: initials(a.name),
      name: a.name,
      color,
      ink: inkFor(color),
    };
  });
  return { chips, extra: Math.max(0, assignees.length - chips.length) };
}

/** Just the first name — all a tight schedule chip has room for. */
export function firstName(name: string): string {
  const first = name.trim().split(/\s+/)[0];
  return first || "?";
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
