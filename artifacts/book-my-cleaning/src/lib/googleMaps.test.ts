import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeMap {}
class FakeInfoWindow {}
class FakeLatLngBounds {}
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
function stubGoogleAsyncBootstrap({ geocodingFails = false } = {}) {
  const importLibrary = vi.fn(async (name: string) => {
    switch (name) {
      case "core":
        return { LatLngBounds: FakeLatLngBounds };
      case "maps":
        return { Map: FakeMap, InfoWindow: FakeInfoWindow };
      case "marker":
        return { AdvancedMarkerElement: FakeAdvancedMarkerElement };
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
    vi.stubGlobal("window", {
      google: { maps: {} },
      document: {
        getElementById: () => null,
        createElement: () => ({
          addEventListener: (type: string, fn: () => void) => {
            if (type === "load") queueMicrotask(fn);
          },
          remove: () => {},
        }),
        head: { appendChild: () => {} },
      },
    });
    vi.stubGlobal("document", window.document);

    const { loadGoogleMaps } = await import("./googleMaps");

    await expect(loadGoogleMaps("test-key")).rejects.toThrow(/importLibrary/);

    // The failed attempt must not be cached, or the page could never recover.
    const importLibrary = stubGoogleAsyncBootstrap();
    const api = await loadGoogleMaps("test-key");
    expect(api.Map).toBe(FakeMap);
    expect(importLibrary).toHaveBeenCalled();
  });
});
