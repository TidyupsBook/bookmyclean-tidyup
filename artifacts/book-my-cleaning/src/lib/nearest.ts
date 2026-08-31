/**
 * "Who is closest to this house?" — the question a dispatcher asks out loud
 * before every reschedule, and the one the map existed to answer.
 *
 * Deliberately straight-line distance. Driving time would be better, but it
 * needs a per-request billed Google call for every cleaner on every job, and a
 * wrong answer that took a second to arrive is worse than an honest "as the
 * crow flies" the office can sanity-check. The ranking is what matters: over a
 * city, the crow and the car almost always agree on who is nearest.
 *
 * Kept free of React and the Maps SDK so it can be tested without a browser.
 */
import type { MapCleaner, StaffHome } from "@workspace/api-client-react";
import { STALE_AFTER_MS, hasCoords } from "./mapMarkers";

export type Coords = { lat: number; lng: number };

/**
 * Where a cleaner was measured from.
 *
 * `live` is a phone reporting in right now; `home` is the address on their
 * staff card. The two answer different questions — "who can swing by this
 * afternoon" versus "who should I give this to next week" — so the source
 * travels with the distance rather than being flattened away.
 */
export type DistanceSource = "live" | "home";

export type NearbyCleaner = {
  teamMemberId: number;
  name: string;
  color?: string | null;
  /** Exact point used for this distance and for map comparison overlays. */
  lat: number;
  lng: number;
  km: number;
  source: DistanceSource;
  /** Only set for a live position: how long ago the phone reported. */
  updatedAt?: string;
  /** From the staff card, so the office can read the actual address back. */
  address?: string | null;
  /** False for someone taken off the roster; still listed, but last. */
  active: boolean;
};

const EARTH_RADIUS_KM = 6371;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/**
 * Great-circle distance in kilometres.
 *
 * Haversine rather than a flat approximation: at Edmonton's latitude a degree
 * of longitude is barely half a degree of latitude, and the cheap version gets
 * cross-city comparisons wrong by enough to reorder the list.
 */
export function haversineKm(a: Coords, b: Coords): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Rank the crew by how far they are from one place.
 *
 * One row per person, never two: a cleaner whose phone is reporting is measured
 * from where they actually are, and everyone else from the address on their
 * card. A position older than the staleness window is ignored in favour of the
 * home address — a phone that went quiet an hour ago is a worse guess than a
 * street the office typed in themselves.
 *
 * Everyone on the roster is listed, in one order: nearest kilometre first.
 * Someone currently off the roster is included too, and simply labelled — the
 * office asks this question about people who are off this week often enough
 * that hiding them, or pushing them below someone twenty kilometres further
 * out, just makes the list lie about who is closest.
 *
 * **The roster-strip hide list is deliberately not applied here.**
 * Hiding a cleaner on the map is a display choice — "I don't need to see
 * their car right now" — not a statement about their availability. The
 * "Closest crew" answer must reflect geography, not the dispatcher's current
 * screen preferences. Passing `hiddenCleaners` into this function was
 * explicitly decided against; if that decision ever changes, update the test
 * "nearest-crew rankings ignore the roster-strip hide list" in nearest.test.ts
 * at the same time.
 */
export function nearestCleaners(
  target: Coords,
  data: { cleaners?: MapCleaner[]; staffHomes?: StaffHome[] },
  now: number = Date.now(),
): NearbyCleaner[] {
  const byMember = new Map<number, NearbyCleaner>();

  for (const home of data.staffHomes ?? []) {
    if (!hasCoords(home)) continue;
    byMember.set(home.teamMemberId, {
      teamMemberId: home.teamMemberId,
      name: home.name,
      color: home.color,
      lat: home.lat,
      lng: home.lng,
      km: haversineKm(target, home),
      source: "home",
      address: home.address ?? null,
      active: home.active,
    });
  }

  for (const cleaner of data.cleaners ?? []) {
    if (!hasCoords(cleaner)) continue;
    const reportedAt = new Date(cleaner.updatedAt).getTime();
    if (Number.isNaN(reportedAt) || now - reportedAt > STALE_AFTER_MS) continue;
    const home = byMember.get(cleaner.teamMemberId);
    // Positions arrive per DEVICE, and this list is per PERSON. Someone with
    // a phone in the van and a tablet on the kitchen counter must be ranked
    // from the van — the freshest fix — not from whichever row happened to
    // come last out of the database.
    if (home?.source === "live" && home.updatedAt) {
      if (new Date(home.updatedAt).getTime() >= reportedAt) continue;
    }
    byMember.set(cleaner.teamMemberId, {
      teamMemberId: cleaner.teamMemberId,
      name: cleaner.name,
      color: cleaner.color ?? home?.color,
      lat: cleaner.lat,
      lng: cleaner.lng,
      km: haversineKm(target, cleaner),
      source: "live",
      updatedAt: cleaner.updatedAt,
      address: home?.address ?? null,
      // A device reporting in is proof enough that they are working, even if
      // their seat is only known to us through their location.
      active: home?.active ?? true,
    });
  }

  return [...byMember.values()].sort((a, b) => a.km - b.km);
}

/**
 * Distance as the office would say it.
 *
 * Metres under a kilometre ("400 m up the road"), one decimal below ten
 * kilometres, whole numbers above — nobody dispatches on 12.37 km.
 */
export function formatKm(km: number): string {
  if (!Number.isFinite(km)) return "—";
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

/**
 * Rough city drive time from a straight-line distance.
 *
 * Mirrors the server's schedule estimate (api-server travel.ts) exactly —
 * ×1.3 because roads are not straight, ~40 km/h across lights and
 * residential streets, and a 5-minute floor because even next door costs
 * parking and pulling out. Same numbers on purpose: the map and the
 * schedule must never disagree about the same leg.
 */
export function estimateDriveMinutes(straightKm: number): number {
  const roadKm = straightKm * 1.3;
  return Math.max(5, Math.round((roadKm / 40) * 60));
}

/**
 * Drive time as the office would say it: "~12 min", "~1 h 20 min".
 * Always prefixed with ~ — it is an estimate, and the UI should read
 * like one.
 */
export function formatDriveMinutes(km: number): string {
  if (!Number.isFinite(km)) return "—";
  const m = estimateDriveMinutes(km);
  if (m < 60) return `~${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `~${h} h` : `~${h} h ${rest} min`;
}
