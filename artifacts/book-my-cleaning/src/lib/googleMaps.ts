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
 * EQUALLY IMPORTANT: the script tag's `load` event is *not* the ready signal.
 * What that URL serves is a small bootstrap that goes on to fetch the real SDK,
 * and `importLibrary` only exists once that second file has run. Waiting on
 * `load` and reading `importLibrary` straight away is a race that Google now
 * loses every time — the map stops working with no change on our side. The
 * `callback=` parameter is the supported ready signal, so that is what this
 * waits for.
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
  /** Draws the cleaner-to-next-job trails. */
  Polyline: any;
  AdvancedMarkerElement: any;
  /**
   * Null when the geocoding library couldn't be pulled in. Turning a dropped
   * pin's coordinates into a street address is a nicety, so its absence must
   * never stop the map from drawing.
   */
  Geocoder: any | null;
};

let loadPromise: Promise<GoogleMapsApi> | null = null;

/**
 * The name Google will call on `window` once the SDK is genuinely usable.
 * A fixed name is safe because the script is only ever injected once.
 */
const READY_CALLBACK = "__bmcGoogleMapsReady";

/**
 * How long to wait for that callback before giving up.
 *
 * It never fires when the key is rejected, so without a ceiling the map area
 * would sit on a spinner forever. Failing instead lets the page say something.
 */
const READY_TIMEOUT_MS = 20_000;

declare global {
  interface Window {
    [READY_CALLBACK]?: () => void;
  }
}

/** Inject the Maps JS bootstrap exactly once and wait until it is ready. */
function injectScript(apiKey: string): Promise<void> {
  // Already bootstrapped (e.g. an HMR reload kept the script around).
  if (typeof window.google?.maps?.importLibrary === "function") {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    const timer = window.setTimeout(() => {
      // Clear the wreckage of this attempt before failing. The tag has to go:
      // a dead script left in the document would make every later attempt
      // think a load was still in flight and wait on a callback that can
      // never come, turning one slow network moment into a map that stays
      // broken until the page is reloaded.
      document.getElementById("google-maps-js")?.remove();
      delete window[READY_CALLBACK];
      finish(new Error("Google Maps did not become ready"));
    }, READY_TIMEOUT_MS);

    // Google calls this the moment `importLibrary` and friends are real. The
    // script tag's own `load` event fires well before that and must not be
    // mistaken for it.
    window[READY_CALLBACK] = () => finish();

    // A tag from a previous attempt is still in flight — its callback is the
    // one we just installed, so simply wait for it.
    if (document.getElementById("google-maps-js")) return;

    const script = document.createElement("script");
    script.id = "google-maps-js";
    // No `libraries` param: libraries are requested explicitly below via
    // importLibrary, which is the supported pairing for loading=async.
    const params = new URLSearchParams({
      key: apiKey,
      v: "weekly",
      loading: "async",
      callback: READY_CALLBACK,
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.addEventListener("error", () => {
      // Drop the tag so a later attempt can inject a fresh one.
      script.remove();
      finish(new Error("Failed to load Google Maps"));
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
  if (!apiKey.trim()) {
    return Promise.reject(new Error("Google Maps API key is missing"));
  }
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
    const api = {
      Map: maps.Map,
      InfoWindow: maps.InfoWindow,
      LatLngBounds: core.LatLngBounds,
      Polyline: maps.Polyline,
      AdvancedMarkerElement: marker.AdvancedMarkerElement,
      Geocoder: geocoding?.Geocoder ?? null,
    };
    const required = [
      ["Map", api.Map],
      ["InfoWindow", api.InfoWindow],
      ["LatLngBounds", api.LatLngBounds],
      ["Polyline", api.Polyline],
      ["AdvancedMarkerElement", api.AdvancedMarkerElement],
    ] as const;
    const missing = required
      .filter(([, constructor]) => typeof constructor !== "function")
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(
        `Google Maps loaded without required constructors: ${missing.join(", ")}`,
      );
    }
    return api;
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
