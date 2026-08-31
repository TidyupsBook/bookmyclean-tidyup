import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeMap {}
class FakeInfoWindow {}
class FakeLatLngBounds {}
class FakePolyline {}
class FakeAdvancedMarkerElement {}
class FakeGeocoder {}

/**
 * Reproduce Google's `loading=async` bootstrap faithfully: `google.maps` exists
 * the moment the script runs, but carries ONLY `importLibrary` — the classes
 * appear when their library is imported.
 *
 * This is the contract that broke the map page. An earlier loader read the
 * constructors straight off `window.google.maps`, which is undefined in this
 * mode, and the page died with "Map is not a constructor". These tests fail if
 * anyone reintroduces that assumption.
 */
function stubGoogleAsyncBootstrap({
  geocodingFails = false,
  missingAdvancedMarker = false,
} = {}) {
  const importLibrary = vi.fn(async (name: string) => {
    switch (name) {
      case "core":
        return { LatLngBounds: FakeLatLngBounds };
      case "maps":
        return {
          Map: FakeMap,
          InfoWindow: FakeInfoWindow,
          Polyline: FakePolyline,
        };
      case "marker":
        return missingAdvancedMarker
          ? {}
          : { AdvancedMarkerElement: FakeAdvancedMarkerElement };
      case "geocoding":
        if (geocodingFails) throw new Error("Geocoding API not enabled");
        return { Geocoder: FakeGeocoder };
      default:
        throw new Error(`unexpected library: ${name}`);
    }
  });

  // Note there is deliberately no Map/InfoWindow/LatLngBounds on the namespace.
  vi.stubGlobal("window", { google: { maps: { importLibrary } } });
  return importLibrary;
}

describe("loadGoogleMaps", () => {
  beforeEach(() => {
    // The module caches its load promise at module scope.
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("resolves with constructors from importLibrary, not off the namespace", async () => {
    const importLibrary = stubGoogleAsyncBootstrap();
    const { loadGoogleMaps } = await import("./googleMaps");

    const api = await loadGoogleMaps("test-key");

    expect(api.Map).toBe(FakeMap);
    expect(api.InfoWindow).toBe(FakeInfoWindow);
    expect(api.LatLngBounds).toBe(FakeLatLngBounds);
    expect(api.AdvancedMarkerElement).toBe(FakeAdvancedMarkerElement);
    expect(api.Geocoder).toBe(FakeGeocoder);
    expect(importLibrary.mock.calls.map((c) => c[0]).sort()).toEqual([
      "core",
      "geocoding",
      "maps",
      "marker",
    ]);
  });

  it("still gives a working map when geocoding is unavailable", async () => {
    // A key without Geocoding API must not cost the dispatcher their map —
    // only the ability to name a dropped pin by its street address.
    stubGoogleAsyncBootstrap({ geocodingFails: true });
    const { loadGoogleMaps } = await import("./googleMaps");

    const api = await loadGoogleMaps("test-key");

    expect(api.Map).toBe(FakeMap);
    expect(api.Geocoder).toBeNull();
  });

  it("rejects a blank browser key before injecting a Maps script", async () => {
    const { loadGoogleMaps } = await import("./googleMaps");

    await expect(loadGoogleMaps("   ")).rejects.toThrow(/key is missing/);
  });

  it("rejects an incomplete SDK instead of leaking a constructor crash into the page", async () => {
    stubGoogleAsyncBootstrap({ missingAdvancedMarker: true });
    const { loadGoogleMaps } = await import("./googleMaps");

    await expect(loadGoogleMaps("test-key")).rejects.toThrow(
      /AdvancedMarkerElement/,
    );
  });

  it("shares one load across concurrent and repeat callers", async () => {
    const importLibrary = stubGoogleAsyncBootstrap();
    const { loadGoogleMaps } = await import("./googleMaps");

    const [first, second] = await Promise.all([
      loadGoogleMaps("test-key"),
      loadGoogleMaps("test-key"),
    ]);
    const third = await loadGoogleMaps("test-key");

    expect(second).toBe(first);
    expect(third).toBe(first);
    // Four calls total: core, maps, marker and geocoding, once each.
    expect(importLibrary).toHaveBeenCalledTimes(4);
  });

  it("rejects, and allows a retry, when the bootstrap has no importLibrary", async () => {
    // An old cached script or a blocked request can leave a namespace stub with
    // nothing useful on it; that must surface as an error, not a silent hang.
    const { announceReady } = stubScriptInjection({
      namespace: { maps: {} },
      announce: "callback",
    });

    const { loadGoogleMaps } = await import("./googleMaps");

    const pending = loadGoogleMaps("test-key");
    announceReady();
    await expect(pending).rejects.toThrow(/importLibrary/);

    // The failed attempt must not be cached, or the page could never recover.
    const importLibrary = stubGoogleAsyncBootstrap();
    const api = await loadGoogleMaps("test-key");
    expect(api.Map).toBe(FakeMap);
    expect(importLibrary).toHaveBeenCalled();
  });

  /**
   * The regression that took the map out entirely.
   *
   * What that script URL serves is a *bootstrap* that goes on to fetch the real
   * SDK. Its `load` event therefore fires while `google.maps.importLibrary`
   * still does not exist, and a loader that treats `load` as "ready" reads an
   * empty namespace and throws. Google changed the bootstrap under us, so this
   * broke a page that nobody had touched — hence a test rather than a comment.
   */
  it("waits for Google's ready callback, not the script's load event", async () => {
    vi.useFakeTimers();
    try {
      const { announceReady } = stubScriptInjection({ announce: "load" });
      const { loadGoogleMaps } = await import("./googleMaps");

      const pending = loadGoogleMaps("test-key");
      // Assert the rejection up front: an unhandled rejection during the timer
      // advance below would otherwise fail the run.
      const settled = expect(pending).rejects.toThrow(/did not become ready/);

      // The script has "loaded" and importLibrary appears a moment later, the
      // way the real bootstrap behaves. A loader racing the load event grabs
      // the namespace here, while it is still empty.
      announceReady();
      await vi.advanceTimersByTimeAsync(50);

      await vi.advanceTimersByTimeAsync(20_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A slow network moment must cost one attempt, not the whole session.
   *
   * The dead tag has to be cleared out with the failed promise: leave it in
   * the document and every later attempt sees "a load is already in flight",
   * waits on a callback that will never come, and the map stays broken until
   * the dispatcher happens to reload the page.
   */
  it("clears the dead script after a timeout so the next attempt can retry", async () => {
    vi.useFakeTimers();
    try {
      const stub = stubScriptInjection({ announce: "callback" });
      const { loadGoogleMaps } = await import("./googleMaps");

      const first = loadGoogleMaps("test-key");
      const failed = expect(first).rejects.toThrow(/did not become ready/);
      await vi.advanceTimersByTimeAsync(20_000);
      await failed;
      expect(stub.isScriptInDocument()).toBe(false);

      const retry = loadGoogleMaps("test-key");
      await vi.advanceTimersByTimeAsync(0);
      expect(stub.isScriptInDocument()).toBe(true);
      stub.announceReady();
      await vi.advanceTimersByTimeAsync(0);

      expect((await retry).Map).toBe(FakeMap);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves once Google's ready callback fires", async () => {
    const { announceReady } = stubScriptInjection({ announce: "callback" });
    const { loadGoogleMaps } = await import("./googleMaps");

    const pending = loadGoogleMaps("test-key");
    announceReady();

    const api = await pending;
    expect(api.Map).toBe(FakeMap);
  });
});

/**
 * A window with no Maps SDK on it yet, standing in for a fresh page load.
 *
 * `announce` decides how the fake script tells the page it has arrived —
 * `"callback"` invokes the global Google is asked to call, `"load"` fires only
 * the script element's load event, which is the weaker signal that must not be
 * enough on its own.
 */
function stubScriptInjection({
  namespace,
  announce,
}: {
  namespace?: { maps: Record<string, unknown> };
  announce: "callback" | "load";
}) {
  const listeners = new Map<string, () => void>();
  // The document tracks the tag the way a real one does — appended, findable
  // by id, gone once removed — because the loader's retry behaviour turns on
  // exactly that.
  let inDocument: any = null;
  const script = {
    id: "",
    src: "",
    async: false,
    addEventListener: (type: string, fn: () => void) => {
      listeners.set(type, fn);
    },
    remove: () => {
      inDocument = null;
    },
  };

  const win: Record<string, any> = {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: any) => clearTimeout(id),
    document: {
      getElementById: (id: string) =>
        inDocument && inDocument.id === id ? inDocument : null,
      createElement: () => script,
      head: {
        appendChild: (el: any) => {
          inDocument = el;
        },
      },
    },
  };
  if (namespace) win["google"] = namespace;

  vi.stubGlobal("window", win);
  vi.stubGlobal("document", win["document"]);

  return {
    /** Is the injected <script> still in the fake document? */
    isScriptInDocument: () => inDocument !== null,
    /** Deliver whichever signal this stub was built to send. */
    announceReady: () => {
      // Whatever arrives, the namespace becomes usable at this moment — the
      // question under test is only which signal the loader believes.
      if (!namespace) {
        win["google"] = { maps: { importLibrary: makeImportLibrary() } };
      }
      if (announce === "load") {
        listeners.get("load")?.();
        return;
      }
      const url = new URL(`https://x/?${script.src.split("?")[1] ?? ""}`);
      const name = url.searchParams.get("callback")!;
      win[name]();
    },
  };
}

function makeImportLibrary() {
  return vi.fn(async (name: string) => {
    switch (name) {
      case "core":
        return { LatLngBounds: FakeLatLngBounds };
      case "maps":
        return {
          Map: FakeMap,
          InfoWindow: FakeInfoWindow,
          Polyline: FakePolyline,
        };
      case "marker":
        return { AdvancedMarkerElement: FakeAdvancedMarkerElement };
      case "geocoding":
        return { Geocoder: FakeGeocoder };
      default:
        throw new Error(`unexpected library: ${name}`);
    }
  });
}
