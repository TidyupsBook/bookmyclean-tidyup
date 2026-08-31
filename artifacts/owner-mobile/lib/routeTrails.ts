/**
 * Pure helpers for the mobile map's cleaner-to-next-job trails. A mirror of
 * the web dashboard's routeTrails.ts so the phone and the office describe the
 * same route the same way — kept free of React and the map SDK so the ETA
 * copy is unit-testable without a device.
 */
import type { MapJob, MapRouteLeg } from "@workspace/api-client-react";

export type { MapJob, MapRouteLeg };

type Point = { lat: number; lng: number };

/**
 * Native map SDKs are stricter than JSON and can terminate the app when a
 * marker or region receives NaN, Infinity, or an out-of-range coordinate.
 * Treat malformed server data as an omitted pin instead of passing it to a
 * platform renderer.
 */
export function isValidMapCoordinate(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export function isValidMapPoint(point: Point): boolean {
  return isValidMapCoordinate(point.lat, point.lng);
}

/**
 * The line colour for a cleaner, matching the web map exactly: their chosen
 * roster colour when it's a valid hex, otherwise a stable hue derived from
 * their id (golden-angle stepping spreads sequential ids apart).
 */
export function colorForTeamMember(
  teamMemberId: number,
  chosen?: string | null,
): string {
  if (chosen && /^#[0-9a-fA-F]{6}$/.test(chosen.trim())) {
    return chosen.trim().toLowerCase();
  }
  const hue = Math.abs(Math.round(teamMemberId * 137.508)) % 360;
  return `hsl(${hue}, 70%, 55%)`;
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

/** "2:45 PM" in the company's zone (never the phone's). */
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

/** The sentence under a cleaner's name in the trail list / callout. */
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

/**
 * "Scheduled 2:45 PM" for a job pin's callout, always in the company's zone —
 * the phone and the office dashboard must agree on the hour.
 */
export function jobPinLabel(job: MapJob, timeZone: string): string {
  const ms = Date.parse(job.scheduledFor);
  if (!Number.isFinite(ms)) return "Scheduled time unknown";
  return `Scheduled ${clockInZone(ms, timeZone)}`;
}

/**
 * The assigned cleaners for a job pin's callout — "Alex, Sam" — or null when
 * Jobber/the office named nobody. Names only: the pin answers "who's on this
 * job" at a glance, same as the web map's crew badges.
 */
export function jobPinCrew(job: MapJob): string | null {
  const names = (job.assignees ?? []).map((a) => a.name.trim()).filter(Boolean);
  return names.length > 0 ? names.join(", ") : null;
}

/**
 * Full callout line for a job pin: the scheduled hour, then who's assigned.
 * "Scheduled 2:45 PM · Alex, Sam" — or just the hour when nobody is.
 */
export function jobPinDescription(job: MapJob, timeZone: string): string {
  const when = jobPinLabel(job, timeZone);
  const crew = jobPinCrew(job);
  return crew ? `${when} · ${crew}` : when;
}

/**
 * The region that shows every trail — and any extra points such as the day's
 * job pins — at once, padded so lines don't kiss the screen edge. Null when
 * there is nothing to frame.
 */
export function regionForTrails(
  routes: MapRouteLeg[],
  extraPoints: Point[] = [],
): {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
} | null {
  const points: Point[] = [...extraPoints];
  for (const r of routes) {
    points.push(...r.path, { lat: r.destLat, lng: r.destLng });
  }
  const validPoints = points.filter(isValidMapPoint);
  if (validPoints.length === 0) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of validPoints) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  // 40% padding around the tightest box; floors keep a single short trail
  // from zooming in to rooftop level.
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max((maxLat - minLat) * 1.4, 0.02),
    longitudeDelta: Math.max((maxLng - minLng) * 1.4, 0.02),
  };
}
