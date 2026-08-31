/**
 * Pure helpers for the live map's cleaner-to-next-job trails. Kept free of
 * React and the Maps SDK, same as mapMarkers.ts, so the ETA copy and the
 * visibility rules are unit-testable without a browser.
 */
import type { MapRouteLeg } from "@workspace/api-client-react";

export type { MapRouteLeg };

type Point = { lat: number; lng: number };

/**
 * Trails follow the roster strip's hide list exactly as the cars do: hiding
 * a cleaner is a display choice, and a route line with no car on it would be
 * a puzzle, not information.
 */
export function visibleTrails(
  routes: MapRouteLeg[],
  hiddenCleaners: { has(id: number): boolean },
): MapRouteLeg[] {
  return routes.filter((r) => !hiddenCleaners.has(r.teamMemberId));
}

/** Where the ETA chip sits — the middle of the drawn line. */
export function midpointOf(path: Point[]): Point | null {
  if (path.length === 0) return null;
  if (path.length === 1) return path[0]!;
  if (path.length === 2) {
    return {
      lat: (path[0]!.lat + path[1]!.lat) / 2,
      lng: (path[0]!.lng + path[1]!.lng) / 2,
    };
  }
  return path[Math.floor(path.length / 2)]!;
}

/** "2:45 PM" in the company's zone (never the browser's). */
export function clockInZone(ms: number, timeZone: string): string {
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    })
      .format(ms)
      // Newer ICU inserts a narrow no-break space before AM/PM; normalize so
      // the label (and tests) read the same everywhere.
      .replace(/[\u202f\u00a0]/g, " ")
  );
}

/** Arriving later than this after the booked time counts as running behind. */
const LATE_GRACE_MS = 5 * 60_000;

export type EtaSummary = {
  /** Whole minutes away, never less than 1 — "0 min" reads as broken. */
  mins: number;
  /** Projected arrival as a clock time in the company zone. */
  arriveClock: string;
  /** Minutes behind the booked time, or null when on time / unknowable. */
  lateMins: number | null;
};

export function etaSummary(
  route: { etaSeconds: number; scheduledFor: string },
  timeZone: string,
  nowMs: number = Date.now(),
): EtaSummary {
  const arriveMs = nowMs + route.etaSeconds * 1000;
  const scheduledMs = Date.parse(route.scheduledFor);
  const lateMins =
    Number.isFinite(scheduledMs) && arriveMs > scheduledMs + LATE_GRACE_MS
      ? Math.round((arriveMs - scheduledMs) / 60_000)
      : null;
  return {
    mins: Math.max(1, Math.round(route.etaSeconds / 60)),
    arriveClock: clockInZone(arriveMs, timeZone),
    lateMins,
  };
}

/** The compact label riding on the trail itself. */
export function chipLabel(
  route: MapRouteLeg,
  timeZone: string,
  nowMs: number = Date.now(),
): string {
  const s = etaSummary(route, timeZone, nowMs);
  const est = route.source === "estimate" ? " (est.)" : "";
  return `${s.mins} min · ${s.arriveClock}${est}`;
}

/** The sentence in the cleaner's info card. */
export function headingLabel(
  route: MapRouteLeg,
  timeZone: string,
  nowMs: number = Date.now(),
): string {
  const s = etaSummary(route, timeZone, nowMs);
  const est = route.source === "estimate" ? " (est.)" : "";
  const timing =
    s.lateMins !== null ? ` · ${s.lateMins} min behind schedule` : " · on time";
  return `Heading to ${route.customerName} · ${s.mins} min away${est} · arrives ${s.arriveClock}${timing}`;
}
