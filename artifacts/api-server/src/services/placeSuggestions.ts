import { logger } from "../lib/logger";
import { EDMONTON_BIAS } from "./geocode";

/**
 * Address suggestions, resolved server-side.
 *
 * The browser used to ask Google directly through the Maps JS SDK, which meant
 * suggestions only worked on a key with **Places API (New)** enabled. That is a
 * separate switch from the two APIs the rest of the map needs, it is off by
 * default, and when it is off the browser sees nothing but a rejected promise —
 * so the box silently stopped suggesting anything with no way to tell why.
 *
 * Asking from here fixes that in two ways: the failure is visible in the server
 * logs, and we can fall back to Google's older Places endpoint, which is still
 * live on keys that predate the new one. The key also stops travelling to the
 * browser for this.
 */

const NEW_URL = "https://places.googleapis.com/v1/places:autocomplete";
const LEGACY_URL =
  "https://maps.googleapis.com/maps/api/place/autocomplete/json";
const REQUEST_TIMEOUT_MS = 6000;
/** Google caps the bias radius at 50km. */
const BIAS_RADIUS_M = 50_000;
/**
 * The company only works in Canada, so suggestions are hard-restricted to it
 * on both endpoints — a restriction, not a bias: a street that only exists in
 * the US simply never appears, instead of outranking the local match.
 */
const COUNTRY_RESTRICTION = "ca";
const MAX_SUGGESTIONS = 5;
/**
 * How long a "the new API is blocked on this key" answer is trusted before we
 * try it again. Long enough that typing doesn't pay for a doomed round trip on
 * every keystroke, short enough that turning the API on takes effect the same
 * afternoon rather than needing a restart.
 */
const BLOCKED_RECHECK_MS = 15 * 60 * 1000;

export type AddressSuggestion = {
  /** Google's place id, or the text itself when there isn't one. */
  id: string;
  /** Street line — what to show in bold. */
  primary: string;
  /** City/region line, may be empty. */
  secondary: string;
  /** The whole address, which is what goes in the box when picked. */
  full: string;
};

export type SuggestionOutcome = {
  suggestions: AddressSuggestion[];
  /**
   * False when Google refused the request outright — a key with no Places
   * access at all. The box then says so instead of looking broken, and typing
   * the address in full still works because saving geocodes free text.
   */
  available: boolean;
};

/** Set when the new API answers "blocked"; cleared after the recheck window. */
let newApiBlockedUntil = 0;

/** Tests reset this so one case's outcome can't decide the next one's path. */
export function resetSuggestionState(): void {
  newApiBlockedUntil = 0;
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Split "12 Main St, Ottawa, ON, Canada" into its street line and the rest. */
function splitAddress(full: string): { primary: string; secondary: string } {
  const parts = full.split(",");
  const primary = (parts.shift() ?? full).trim();
  return { primary, secondary: parts.join(",").trim() };
}

/** Places API (New). Returns null when this key may not use it. */
async function suggestViaNewApi(
  apiKey: string,
  query: string,
  bias?: { lat: number; lng: number },
): Promise<AddressSuggestion[] | null> {
  if (Date.now() < newApiBlockedUntil) return null;

  const payload: Record<string, unknown> = {
    input: query,
    includedRegionCodes: [COUNTRY_RESTRICTION],
  };
  if (bias) {
    payload["locationBias"] = {
      circle: {
        center: { latitude: bias.lat, longitude: bias.lng },
        radius: BIAS_RADIUS_M,
      },
    };
  }

  const { status, body } = await fetchJson(NEW_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
    },
    body: JSON.stringify(payload),
  });

  // 403 is the shape a disabled/restricted API takes here; 404 covers a key on
  // a project where the endpoint was never provisioned.
  if (status === 403 || status === 404) {
    newApiBlockedUntil = Date.now() + BLOCKED_RECHECK_MS;
    logger.warn(
      { status, reason: body?.error?.status },
      "[places] Places API (New) is blocked for this key; using the older endpoint",
    );
    return null;
  }
  if (status !== 200) {
    throw new Error(`Places autocomplete failed with status ${status}`);
  }

  const raw: any[] = Array.isArray(body?.suggestions) ? body.suggestions : [];
  return raw
    .map((entry) => entry?.placePrediction)
    .filter(Boolean)
    .slice(0, MAX_SUGGESTIONS)
    .map((prediction: any) => {
      const full = String(prediction?.text?.text ?? "").trim();
      const primary = String(
        prediction?.structuredFormat?.mainText?.text ?? "",
      ).trim();
      const secondary = String(
        prediction?.structuredFormat?.secondaryText?.text ?? "",
      ).trim();
      const split = splitAddress(full);
      return {
        id: String(prediction?.placeId ?? full),
        primary: primary || split.primary,
        secondary: secondary || split.secondary,
        full,
      };
    })
    .filter((s) => s.full.length > 0);
}

/** The older Places endpoint, still enabled on keys that predate the new one. */
async function suggestViaLegacyApi(
  apiKey: string,
  query: string,
  bias?: { lat: number; lng: number },
): Promise<SuggestionOutcome> {
  const params = new URLSearchParams({
    input: query,
    key: apiKey,
    components: `country:${COUNTRY_RESTRICTION}`,
  });
  if (bias) {
    params.set("location", `${bias.lat},${bias.lng}`);
    params.set("radius", String(BIAS_RADIUS_M));
  }

  const { status, body } = await fetchJson(`${LEGACY_URL}?${params}`, {
    method: "GET",
  });
  if (status !== 200) {
    throw new Error(`Places autocomplete failed with status ${status}`);
  }

  // Like geocoding, this API reports refusal in the body with HTTP 200, so a
  // plain `res.ok` check would sail straight past a key with no access.
  const googleStatus = String(body?.status ?? "");
  if (googleStatus === "REQUEST_DENIED" || googleStatus === "INVALID_REQUEST") {
    logger.warn(
      { googleStatus, message: body?.error_message },
      "[places] Google refused the address suggestion request",
    );
    return { suggestions: [], available: false };
  }
  if (googleStatus !== "OK" && googleStatus !== "ZERO_RESULTS") {
    throw new Error(`Places autocomplete returned ${googleStatus}`);
  }

  const predictions: any[] = Array.isArray(body?.predictions)
    ? body.predictions
    : [];
  return {
    available: true,
    suggestions: predictions
      .slice(0, MAX_SUGGESTIONS)
      .map((prediction) => {
        const full = String(prediction?.description ?? "").trim();
        const split = splitAddress(full);
        return {
          id: String(prediction?.place_id ?? full),
          primary: String(
            prediction?.structured_formatting?.main_text ?? split.primary,
          ),
          secondary: String(
            prediction?.structured_formatting?.secondary_text ??
              split.secondary,
          ),
          full,
        };
      })
      .filter((s) => s.full.length > 0),
  };
}

/**
 * Suggest addresses for what has been typed so far.
 *
 * Tries the current API first so a key that has it enabled gets the better
 * results, and falls back to the older one rather than showing nothing.
 */
export async function suggestAddresses(
  query: string,
  bias?: { lat: number; lng: number },
): Promise<SuggestionOutcome> {
  // A dedicated Places key wins when one exists: the map key is often locked
  // down to Maps + Geocoding, and suggestions then fail on their own.
  const apiKey =
    process.env["PLACES_API1"] ?? process.env["GOOGLE_MAPS_API_KEY"] ?? "";
  if (!apiKey) return { suggestions: [], available: false };

  const trimmed = query.trim();
  if (trimmed.length < 3) return { suggestions: [], available: true };

  // No bias from the caller means "somewhere we work", which is Edmonton.
  const effectiveBias = bias ?? EDMONTON_BIAS;

  const viaNew = await suggestViaNewApi(apiKey, trimmed, effectiveBias);
  if (viaNew) return { suggestions: viaNew, available: true };

  return suggestViaLegacyApi(apiKey, trimmed, effectiveBias);
}
