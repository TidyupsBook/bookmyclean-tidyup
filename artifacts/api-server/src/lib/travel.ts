/**
 * Travel legs for a cleaner's day: home → first job, then job → job.
 *
 * Deliberately straight-line distance with a city-driving estimate on top.
 * True drive times would need a billed Google Directions call for every leg
 * of every lane on every schedule load; over a city the crow and the car
 * agree closely enough for "how long to the next job", and the estimate is
 * labelled as one in the UI.
 */

export type LatLng = { lat: number; lng: number };

const EARTH_RADIUS_KM = 6371;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * Rough city drive time from a straight-line distance.
 *
 * Roads are not straight (×1.3) and city driving averages ~40 km/h across
 * lights and residential streets; anything under it still costs a few
 * minutes of parking and pulling out, hence the floor.
 */
export function estimateDriveMinutes(straightKm: number): number {
  const roadKm = straightKm * 1.3;
  const minutes = (roadKm / 40) * 60;
  return Math.max(5, Math.round(minutes));
}

export type TravelLeg = {
  fromHome: boolean;
  fromLabel: string;
  distanceKm: number;
  driveMinutes: number;
};

/**
 * Attach a travel leg to each job in a lane, in time order.
 *
 * The anchor starts at the cleaner's home (when it's geocoded) and advances
 * to each job that has coordinates. A job without coordinates gets no leg
 * and does not move the anchor — the next located job measures from the
 * last place we could actually point to.
 */
export function travelLegsForLane<
  T extends { lat: number | null; lng: number | null; label: string },
>(jobs: T[], home: LatLng | null): (TravelLeg | null)[] {
  let anchor: (LatLng & { label: string; fromHome: boolean }) | null = home
    ? { ...home, label: "home", fromHome: true }
    : null;
  return jobs.map((job) => {
    if (job.lat == null || job.lng == null) return null;
    const here = { lat: job.lat, lng: job.lng };
    let leg: TravelLeg | null = null;
    if (anchor) {
      const km = haversineKm(anchor, here);
      leg = {
        fromHome: anchor.fromHome,
        fromLabel: anchor.label,
        distanceKm: Math.round(km * 10) / 10,
        driveMinutes: estimateDriveMinutes(km),
      };
    }
    anchor = { ...here, label: job.label, fromHome: false };
    return leg;
  });
}
