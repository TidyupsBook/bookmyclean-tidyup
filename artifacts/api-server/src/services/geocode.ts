import { logger } from "../lib/logger";

/**
 * Server-side geocoding via the Google Geocoding API.
 *
 * The key never reaches the browser: addresses are resolved here and only the
 * coordinates are stored/returned. Results are cached in-process by normalized
 * address, requests are capped for concurrency, and each call has a timeout so
 * a slow Google response can't pile up open sockets.
 *
 * A geocoder can be injected for tests — Google almost never returns
 * ZERO_RESULTS for a made-up string (it resolves gibberish to something
 * approximate), so a negative-path test MUST inject a stub rather than rely on
 * a fake address failing.
 */

export type GeocodeResult = { lat: number; lng: number };

/**
 * Roughly where the company works, used to bias a lookup.
 *
 * Street names repeat across the continent, and a bare "17115 61 Ave" is as
 * good a match in Virginia as in Alberta — Google returns the far one with
 * full confidence rather than an error. Biasing toward the area a company
 * actually cleans in is what keeps a typo out of the wrong country.
 */
export type GeocodeBias = { lat: number; lng: number };

/**
 * The company cleans in Alberta, Canada — nowhere else. Every lookup is
 * hard-restricted to Canada (Google's `components=country:CA`), which is a
 * filter, not a preference: a bare "123 Main St" can no longer resolve to a
 * confident match in Virginia. Folded into the cache keys below so entries
 * cached before the restriction existed (some of them US results, some of
 * them misses that would now hit) re-resolve instead of being replayed.
 */
const COUNTRY_RESTRICTION = "ca";

/**
 * Where a lookup leans when the caller supplies no bias of its own:
 * Edmonton, the middle of the service area. A caller-provided bias (a
 * company's own office) always wins over this.
 */
export const EDMONTON_BIAS: GeocodeBias = { lat: 53.5461, lng: -113.4938 };

/**
 * Half-size of the box drawn around the bias point, in degrees.
 *
 * About 110 km north-south and, at Edmonton's latitude, roughly 100 km
 * east-west: wide enough to cover a metro area and its acreages, tight enough
 * to exclude the next province. Google treats this as a preference, so an
 * address genuinely outside it still resolves when nothing local matches —
 * which is what "unless you searched for it" means to the person typing.
 */
const BIAS_DEGREES = 1;

/**
 * The shape a geocoder must satisfy: resolve an address to coordinates, or
 * null when it genuinely can't be placed. May throw for transient/config
 * failures (network, REQUEST_DENIED) so callers can tell "no such place" apart
 * from "geocoding is broken right now".
 */
export type Geocoder = (
  address: string,
  bias?: GeocodeBias,
) => Promise<GeocodeResult | null>;

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const REQUEST_TIMEOUT_MS = 8000;
const MAX_CONCURRENCY = 3;
/** Cache entries live an hour — addresses don't move, but keys can be rotated. */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Raised when Google rejects the key/config, so callers can degrade quietly. */
export class GeocodeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeocodeConfigError";
  }
}

/** Collapse whitespace and case so "12 Main St " and "12 main st" share a slot. */
export function normalizeAddress(address: string): string {
  return address.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The key an address is cached under in the persistent geocoded_addresses
 * table. The country restriction is part of the key on purpose: rows written
 * before lookups were locked to Canada (under the bare normalized address)
 * simply never match again, so a US result — or a miss that would now hit
 * inside Canada — is re-resolved on its next lookup rather than replayed.
 */
export function geocodeCacheKey(address: string): string {
  return `${COUNTRY_RESTRICTION}:${normalizeAddress(address)}`;
}

const cache = new Map<string, { result: GeocodeResult | null; at: number }>();

// A tiny promise-based semaphore so at most MAX_CONCURRENCY geocode requests
// are in flight at once — a backfill batch must not open a hundred sockets.
let active = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENCY) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
}

function release(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}

/**
 * The real Google geocoder. Throws GeocodeConfigError when the key is missing
 * or Google answers REQUEST_DENIED/OVER_QUERY_LIMIT, returns null on
 * ZERO_RESULTS, and returns coordinates otherwise.
 */
export const googleGeocoder: Geocoder = async (address, bias) => {
  const key = process.env["GOOGLE_MAPS_API_KEY"];
  if (!key) {
    throw new GeocodeConfigError("GOOGLE_MAPS_API_KEY is not configured");
  }

  // `bounds` prefers matches inside the box without refusing everything else,
  // which is exactly the behaviour wanted: local streets win, a genuinely
  // distant address still resolves.
  const bounds = bias
    ? `&bounds=${bias.lat - BIAS_DEGREES},${bias.lng - BIAS_DEGREES}|${bias.lat + BIAS_DEGREES},${bias.lng + BIAS_DEGREES}`
    : "";
  // `components=country:CA` is a hard filter, unlike bounds: Google will
  // return ZERO_RESULTS rather than a US match for a street that only exists
  // south of the border.
  const url = `${GEOCODE_URL}?address=${encodeURIComponent(address)}${bounds}&components=country:${COUNTRY_RESTRICTION.toUpperCase()}&key=${encodeURIComponent(key)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let body: {
    status: string;
    results?: Array<{ geometry?: { location?: { lat: number; lng: number } } }>;
    error_message?: string;
  };
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Google Geocoding returned HTTP ${res.status}`);
    }
    body = (await res.json()) as typeof body;
  } finally {
    clearTimeout(timer);
  }

  if (body.status === "OK" && body.results && body.results.length > 0) {
    const loc = body.results[0]?.geometry?.location;
    if (loc && typeof loc.lat === "number" && typeof loc.lng === "number") {
      return { lat: loc.lat, lng: loc.lng };
    }
    return null;
  }
  if (body.status === "ZERO_RESULTS") return null;
  if (body.status === "REQUEST_DENIED" || body.status === "OVER_QUERY_LIMIT") {
    throw new GeocodeConfigError(
      `Google Geocoding ${body.status}: ${body.error_message ?? "no detail"}`,
    );
  }
  throw new Error(
    `Google Geocoding ${body.status}: ${body.error_message ?? "no detail"}`,
  );
};

let activeGeocoder: Geocoder = googleGeocoder;

/** Swap the geocoder — tests inject a stub, the app leaves the Google default. */
export function setGeocoder(geocoder: Geocoder): void {
  activeGeocoder = geocoder;
}

/** Reset back to the real Google geocoder (used by test teardown). */
export function resetGeocoder(): void {
  activeGeocoder = googleGeocoder;
}

/** Clear the in-memory cache (used by tests to keep runs independent). */
export function clearGeocodeCache(): void {
  cache.clear();
}

/**
 * Resolve an address to coordinates, or null when it can't be placed. Shared
 * by the map-pin route and the background backfill so both cache the same
 * lookups and honour the same concurrency cap. Re-throws GeocodeConfigError so
 * the backfill can log-once-and-back-off on a dead key.
 */
export async function geocodeAddress(
  address: string,
  bias?: GeocodeBias,
): Promise<GeocodeResult | null> {
  const normalized = normalizeAddress(address);
  if (!normalized) return null;

  // No bias from the caller means "somewhere we work", which is Edmonton.
  const effectiveBias = bias ?? EDMONTON_BIAS;

  // The bias is part of the question, so it has to be part of the cache key —
  // the same street text can legitimately resolve to two different places for
  // two companies. Rounded to a coarse grid so every job on a block shares one
  // entry instead of each one paying for its own lookup. The country
  // restriction is in the key too, so entries cached before lookups were
  // locked to Canada are never replayed.
  const key = `${COUNTRY_RESTRICTION}:${normalized}|${effectiveBias.lat.toFixed(1)},${effectiveBias.lng.toFixed(1)}`;

  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.result;
  }

  await acquire();
  try {
    const result = await activeGeocoder(address, effectiveBias);
    cache.set(key, { result, at: Date.now() });
    return result;
  } catch (err) {
    // Config errors are the caller's to handle; a transient failure just isn't
    // cached so the next attempt can retry.
    if (!(err instanceof GeocodeConfigError)) {
      logger.warn({ err }, "Geocoding request failed");
    }
    throw err;
  } finally {
    release();
  }
}
