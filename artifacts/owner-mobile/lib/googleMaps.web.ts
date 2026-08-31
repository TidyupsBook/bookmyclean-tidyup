/**
 * Browser-only Google Maps loader for the phone app. The key comes from the
 * authenticated /map/config endpoint at runtime; it is never bundled.
 */
export type GoogleMapsApi = {
  Map: any;
  LatLngBounds: any;
  Polyline: any;
  AdvancedMarkerElement: any;
};

let loadPromise: Promise<GoogleMapsApi> | null = null;
const SCRIPT_ID = "bmc-mobile-google-maps";
const READY_CALLBACK = "__bmcMobileGoogleMapsReady";
type MapsAuthFailureHandler = () => void;

function browserWindow() {
  return window as typeof window & {
    google?: { maps?: { importLibrary?: (name: string) => Promise<any> } };
    gm_authFailure?: MapsAuthFailureHandler;
    [READY_CALLBACK]?: () => void;
  };
}

/**
 * Google reports a rejected browser key through this global rather than a
 * thrown error. Keep it visible to the caller so Safari never looks like it
 * has crashed when Maps refuses to draw.
 */
export function installGoogleMapsAuthFailureHandler(
  handler: MapsAuthFailureHandler,
): () => void {
  const w = browserWindow();
  const previous = w.gm_authFailure;
  const listener = () => {
    previous?.();
    handler();
  };
  w.gm_authFailure = listener;
  return () => {
    if (w.gm_authFailure === listener) w.gm_authFailure = previous;
  };
}

function injectScript(apiKey: string): Promise<void> {
  const w = browserWindow();
  if (typeof w.google?.maps?.importLibrary === "function") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = window.setTimeout(() => {
      document.getElementById(SCRIPT_ID)?.remove();
      delete w[READY_CALLBACK];
      finish(new Error("Google Maps did not become ready"));
    }, 20_000);

    w[READY_CALLBACK] = () => finish();
    if (document.getElementById(SCRIPT_ID)) return;

    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.async = true;
    script.src = `https://maps.googleapis.com/maps/api/js?${new URLSearchParams(
      {
        key: apiKey,
        v: "weekly",
        loading: "async",
        callback: READY_CALLBACK,
      },
    ).toString()}`;
    script.addEventListener("error", () => {
      script.remove();
      finish(new Error("Google Maps could not be downloaded"));
    });
    document.head.appendChild(script);
  });
}

/** Load the Maps SDK only after the caller has fetched an authenticated key. */
export function loadGoogleMaps(apiKey: string): Promise<GoogleMapsApi> {
  if (!apiKey.trim()) {
    return Promise.reject(new Error("Google Maps is not configured"));
  }
  if (loadPromise) return loadPromise;

  const attempt = (async () => {
    await injectScript(apiKey);
    const maps = browserWindow().google?.maps;
    if (!maps?.importLibrary) {
      throw new Error("Google Maps did not expose importLibrary");
    }
    const [core, mapLibrary, marker] = await Promise.all([
      maps.importLibrary("core"),
      maps.importLibrary("maps"),
      maps.importLibrary("marker"),
    ]);
    const api = {
      Map: mapLibrary.Map,
      LatLngBounds: core.LatLngBounds,
      Polyline: mapLibrary.Polyline,
      AdvancedMarkerElement: marker.AdvancedMarkerElement,
    };
    if (
      Object.values(api).some(
        (constructor) => typeof constructor !== "function",
      )
    ) {
      throw new Error("Google Maps loaded without required map constructors");
    }
    return api;
  })();

  loadPromise = attempt;
  attempt.catch(() => {
    if (loadPromise === attempt) loadPromise = null;
  });
  return attempt;
}
