/**
 * Driving routes for the live map's cleaner-to-next-job trails.
 *
 * Every Google Directions call is billed, and the dashboard polls the trail
 * endpoint every 30 seconds — so this module is mostly a cache with a Google
 * call behind it. A cleaner's route is only re-asked when they have actually
 * moved, their destination changed, or the answer has aged out; a parked car
 * costs one lookup, not two a minute.
 *
 * When Google can't answer (no key, key not enabled for Directions, network
 * trouble, no road between the points) the caller falls back to
 * `estimateRoute` — the same straight-line arithmetic the schedule's travel
 * legs use — and labels it an estimate. The map keeps working either way.
 *
 * Test seam mirrors services/geocode.ts: `setDirectionsProvider` swaps the
 * Google call for a fake, `clearDirectionsCache` isolates tests.
 */
import { haversineKm, estimateDriveMinutes, type LatLng } from "../lib/travel";
import { decodePolyline } from "../lib/polyline";
import { logger } from "../lib/logger";

export type DrivingRoute = {
  etaSeconds: number;
  distanceMeters: number;
  path: LatLng[];
  source: "google" | "estimate";
};

type Provider = (origin: LatLng, dest: LatLng) => Promise<DrivingRoute | null>;

/** A cached route is served as-is for this long, even without movement. */
const ROUTE_FRESH_MS = 3 * 60_000;
/** Re-ask Google once the cleaner has moved this far from the cached origin. */
const REFETCH_AFTER_KM = 0.15;
/** A key Google rejected outright is not retried for a while. */
const CONFIG_DEAD_MS = 10 * 60_000;
/** After any failure, don't re-ask for the same cleaner for a minute. */
const FAIL_QUIET_MS = 60_000;
const FETCH_TIMEOUT_MS = 8_000;

/** Set when Google says the key itself is the problem — not worth retrying per-cleaner. */
let configDeadUntil = 0;

const googleProvider: Provider = async (origin, dest) => {
  const key = process.env["GOOGLE_MAPS_API_KEY"];
  if (!key) return null;
  if (Date.now() < configDeadUntil) return null;

  const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
  url.searchParams.set("origin", `${origin.lat},${origin.lng}`);
  url.searchParams.set("destination", `${dest.lat},${dest.lng}`);
  url.searchParams.set("mode", "driving");
  url.searchParams.set("key", key);

  const resp = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as {
    status?: string;
    error_message?: string;
    routes?: Array<{
      overview_polyline?: { points?: string };
      legs?: Array<{
        duration?: { value?: number };
        distance?: { value?: number };
      }>;
    }>;
  };

  if (data.status === "REQUEST_DENIED" || data.status === "OVER_QUERY_LIMIT") {
    // The key can't do Directions at all (or the quota is gone) — every
    // other cleaner's lookup would fail identically, so stop asking for a
    // while rather than paying the latency on every poll.
    configDeadUntil = Date.now() + CONFIG_DEAD_MS;
    logger.warn(
      { status: data.status, message: data.error_message },
      "[map] directions unavailable; trails fall back to estimates",
    );
    return null;
  }

  const route = data.routes?.[0];
  const leg = route?.legs?.[0];
  const encoded = route?.overview_polyline?.points;
  if (data.status !== "OK" || !leg || typeof encoded !== "string") return null;

  const etaSeconds = Math.round(Number(leg.duration?.value));
  const distanceMeters = Math.round(Number(leg.distance?.value));
  if (!Number.isFinite(etaSeconds) || !Number.isFinite(distanceMeters)) {
    return null;
  }

  const decoded = decodePolyline(encoded);
  return {
    etaSeconds,
    distanceMeters,
    path: decoded.length >= 2 ? decoded : [origin, dest],
    source: "google",
  };
};

let provider: Provider = googleProvider;

/** Tests swap in a deterministic provider; production never calls this. */
export function setDirectionsProvider(next: Provider): void {
  provider = next;
}

export function resetDirectionsProvider(): void {
  provider = googleProvider;
  configDeadUntil = 0;
}

type CacheEntry = {
  origin: LatLng;
  destKey: string;
  route: DrivingRoute;
  at: number;
};

const cache = new Map<string, CacheEntry>();
const failedAt = new Map<string, number>();

export function clearDirectionsCache(): void {
  cache.clear();
  failedAt.clear();
}

/** Five decimals is about a metre — the same house is the same destination. */
const destKeyOf = (dest: LatLng) =>
  `${dest.lat.toFixed(5)},${dest.lng.toFixed(5)}`;

/**
 * The driving route from `origin` to `dest`, cached under `cacheKey`
 * (one per cleaner). Null means "Google couldn't say" — callers estimate.
 */
export async function getDrivingRoute(
  cacheKey: string,
  origin: LatLng,
  dest: LatLng,
): Promise<DrivingRoute | null> {
  const now = Date.now();
  const destKey = destKeyOf(dest);

  const hit = cache.get(cacheKey);
  if (
    hit &&
    hit.destKey === destKey &&
    now - hit.at < ROUTE_FRESH_MS &&
    haversineKm(hit.origin, origin) < REFETCH_AFTER_KM
  ) {
    return hit.route;
  }

  const lastFail = failedAt.get(cacheKey);
  if (lastFail !== undefined && now - lastFail < FAIL_QUIET_MS) return null;

  let route: DrivingRoute | null = null;
  try {
    route = await provider(origin, dest);
  } catch (err) {
    logger.warn({ err }, "[map] directions lookup failed");
    route = null;
  }

  if (!route) {
    failedAt.set(cacheKey, now);
    return null;
  }
  failedAt.delete(cacheKey);
  cache.set(cacheKey, { origin, destKey, route, at: now });
  return route;
}

/**
 * The fallback trail: a straight line and the same city-driving arithmetic
 * as the schedule's travel legs, clearly labelled `estimate`.
 */
export function estimateRoute(origin: LatLng, dest: LatLng): DrivingRoute {
  const km = haversineKm(origin, dest);
  return {
    etaSeconds: estimateDriveMinutes(km) * 60,
    distanceMeters: Math.round(km * 1.3 * 1000),
    path: [origin, dest],
    source: "estimate",
  };
}
