/**
 * Runtime Google Maps loader. The API key is NEVER baked into the bundle — we
 * fetch it from /map/config (authed) and only then inject the Maps JS script,
 * so the key is scoped to signed-in dispatchers instead of shipping to anyone
 * who downloads the site.
 *
 * IMPORTANT: we load with `loading=async`, which puts the SDK in *dynamic
 * library* mode. In that mode `window.google.maps` exists as soon as the script
 * runs, but it is only a stub — `google.maps.Map`, `InfoWindow`,
 * `LatLngBounds` and friends are NOT on it until the owning library has been
 * pulled in via `importLibrary()`. Constructing straight off the namespace
 * throws "g.Map is not a constructor".
 *
 * So this module resolves with the constructors themselves. Callers use what
 * they are handed and never touch `window.google`, which makes the ordering
 * bug impossible to reintroduce.
 */

// The Maps SDK has no bundled types here and we don't want to pull in
// @types/google.maps just for a handful of calls, so the constructors are
// typed loosely.

/** The handful of Maps classes this app constructs. */
export type GoogleMapsApi = {
  Map: any;
  InfoWindow: any;
  LatLngBounds: any;
  AdvancedMarkerElement: any;
  /**
   * Null when the geocoding library couldn't be pulled in. Turning a dropped
   * pin's coordinates into a street address is a nicety, so its absence must
   * never stop the map from drawing.
   */
  Geocoder: any | null;
};

let loadPromise: Promise<GoogleMapsApi> | null = null;

/** Inject the Maps JS bootstrap exactly once. */
function injectScript(apiKey: string): Promise<void> {
  // Already bootstrapped (e.g. an HMR reload kept the script around).
  if (typeof window.google?.maps?.importLibrary === "function") {
    return Promise.resolve();
  }

  const existing = document.getElementById(
    "google-maps-js",
  ) as HTMLScriptElement | null;
  if (existing) {
    return new Promise<void>((resolve, reject) => {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () =>
        reject(new Error("Failed to load Google Maps")),
      );
    });
  }

  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.id = "google-maps-js";
    // No `libraries` param: libraries are requested explicitly below via
    // importLibrary, which is the supported pairing for loading=async.
    const params = new URLSearchParams({
      key: apiKey,
      v: "weekly",
      loading: "async",
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () => {
      // Drop the tag so a later attempt can inject a fresh one.
      script.remove();
      reject(new Error("Failed to load Google Maps"));
    });
    document.head.appendChild(script);
  });
}

/**
 * Load the Maps JS SDK and the libraries this app needs, exactly once per page.
 * Repeat callers share the same promise, so switching dates or remounting never
 * injects a second <script>.
 *
 * Rejects if the script fails to download. Google's *authorization* failures
 * (key not enabled for Maps JS) do NOT reject here — they only surface through
 * the global `window.gm_authFailure` callback, which the page registers.
 */
export function loadGoogleMaps(apiKey: string): Promise<GoogleMapsApi> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Google Maps can only load in a browser"));
  }
  if (loadPromise) return loadPromise;

  const attempt = (async (): Promise<GoogleMapsApi> => {
    await injectScript(apiKey);
    const g = window.google?.maps;
    if (!g?.importLibrary) {
      throw new Error("Google Maps loaded without importLibrary support");
    }
    // core holds LatLngBounds; maps holds Map/InfoWindow; marker holds the
    // advanced markers. Requesting them together avoids three round trips.
    const [core, maps, marker, geocoding] = await Promise.all([
      g.importLibrary("core"),
      g.importLibrary("maps"),
      g.importLibrary("marker"),
      // Only used to name a dropped pin. Optional on purpose: a key without
      // Geocoding API must still get a working map.
      g.importLibrary("geocoding").catch(() => null),
    ]);
    return {
      Map: maps.Map,
      InfoWindow: maps.InfoWindow,
      LatLngBounds: core.LatLngBounds,
      AdvancedMarkerElement: marker.AdvancedMarkerElement,
      Geocoder: geocoding?.Geocoder ?? null,
    };
  })();

  loadPromise = attempt;
  // Let a later attempt (e.g. after a network blip) retry from scratch, while
  // still rejecting this call's promise for the caller that is waiting on it.
  attempt.catch(() => {
    if (loadPromise === attempt) loadPromise = null;
  });

  return attempt;
}

/** The map id required for AdvancedMarkerElement styling. */
export const DEMO_MAP_ID = "DEMO_MAP_ID";

/**
 * Name a point the dispatcher clicked on the map.
 *
 * Returns null rather than throwing when the lookup is unavailable or comes
 * back empty — the pin is still perfectly droppable, it just gets called by
 * its coordinates instead of a street address.
 */
export async function reverseGeocode(
  api: GoogleMapsApi,
  lat: number,
  lng: number,
): Promise<string | null> {
  if (!api.Geocoder) return null;
  try {
    const { results } = await new api.Geocoder().geocode({
      location: { lat, lng },
    });
    const formatted = results?.[0]?.formatted_address;
    return typeof formatted === "string" && formatted.trim()
      ? formatted.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * Address autocomplete, loaded separately from the map itself.
 *
 * This is the *data* API rather than Google's drop-in widget: it returns plain
 * predictions so the dropdown can be our own markup in our own theme, instead
 * of fighting a web component's shadow DOM.
 *
 * Needs "Places API (New)" enabled on the key — a separate switch from Maps
 * JavaScript API and Geocoding API. A key without it rejects the first request,
 * which is why callers must treat failure as "no suggestions" and keep the
 * plain text box working.
 */
export type GooglePlacesApi = {
  AutocompleteSuggestion: any;
  AutocompleteSessionToken: any;
};

let placesPromise: Promise<GooglePlacesApi> | null = null;

export function loadGooglePlaces(apiKey: string): Promise<GooglePlacesApi> {
  if (typeof window === "undefined") {
    return Promise.reject(
      new Error("Google Places can only load in a browser"),
    );
  }
  if (placesPromise) return placesPromise;

  const attempt = (async (): Promise<GooglePlacesApi> => {
    await injectScript(apiKey);
    const g = window.google?.maps;
    if (!g?.importLibrary) {
      throw new Error("Google Maps loaded without importLibrary support");
    }
    const places = await g.importLibrary("places");
    if (!places?.AutocompleteSuggestion) {
      throw new Error("Places autocomplete is not available on this key");
    }
    return {
      AutocompleteSuggestion: places.AutocompleteSuggestion,
      AutocompleteSessionToken: places.AutocompleteSessionToken,
    };
  })();

  placesPromise = attempt;
  attempt.catch(() => {
    if (placesPromise === attempt) placesPromise = null;
  });

  return attempt;
}
