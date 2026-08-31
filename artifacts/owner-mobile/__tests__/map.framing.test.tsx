// @vitest-environment jsdom
/**
 * The Map tab's opening camera: TrailMap must frame once, and only after BOTH
 * the trails and the job-pin requests have answered — whichever dataset lands
 * second must still be inside the first framed region. After that first
 * frame, later data must never move the camera again.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, cleanup } from "@testing-library/react";
import { AppState } from "react-native";
import type { MapJob, MapRouteLeg } from "@/lib/routeTrails";

const googleMapsMocks = vi.hoisted(() => ({
  loadGoogleMaps: vi.fn(),
  installGoogleMapsAuthFailureHandler: vi.fn(() => vi.fn()),
}));
vi.mock("@/lib/googleMaps.web", () => googleMapsMocks);

const animateToRegion = vi.fn();
const setCamera = vi.fn();
const getCamera = vi.fn();
let signalMapReady: (() => void) | undefined;
let signalAppState: ((state: string) => void) | undefined;
let signalRegionChangeComplete: (() => void) | undefined;
let signalNativeMapTeardown: (() => void) | undefined;

// Stub react-native-maps (no web renderer): MapView forwards a ref exposing
// animateToRegion so the framing effect is observable; children render inert.
vi.mock("react-native-maps", () => {
  const MapView = React.forwardRef(function MapView(
    {
      children,
      onMapReady,
      onRegionChangeComplete,
    }: {
      children?: React.ReactNode;
      onMapReady?: () => void;
      onRegionChangeComplete?: () => void;
    },
    ref: React.Ref<unknown>,
  ) {
    const [nativeMounted, setNativeMounted] = React.useState(true);
    signalMapReady = onMapReady;
    signalRegionChangeComplete = onRegionChangeComplete;
    signalNativeMapTeardown = () => {
      setNativeMounted(false);
      setNativeMounted(true);
    };
    React.useImperativeHandle(ref, () => ({
      animateToRegion,
      setCamera,
      getCamera,
    }));
    return nativeMounted ? <>{children}</> : null;
  });
  return {
    default: MapView,
    Marker: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    Polyline: () => null,
  };
});

import { TrailMap } from "@/components/TrailMap";
import { TrailMap as BrowserTrailMap } from "@/components/TrailMap.web";

const TZ = "America/Edmonton";

class MockBounds {
  points: Array<{ lat: number; lng: number }> = [];

  extend(point: { lat: number; lng: number }) {
    this.points.push(point);
  }
}

class MockBrowserMap {
  static instances: MockBrowserMap[] = [];
  readonly fitBounds = vi.fn();
  private idleListener?: { remove: () => void };
  private center: { lat: number; lng: number };
  private zoom: number;

  constructor(
    _container: unknown,
    options: {
      center: { lat: number; lng: number };
      zoom: number;
    },
  ) {
    this.center = options.center;
    this.zoom = options.zoom;
    MockBrowserMap.instances.push(this);
  }

  addListener(event: string, listener: () => void) {
    if (event === "idle") {
      this.idleListener = { remove: vi.fn() };
      (this.idleListener as { callback?: () => void }).callback = listener;
      return this.idleListener;
    }
    return { remove: vi.fn() };
  }

  getCenter() {
    return {
      lat: () => this.center.lat,
      lng: () => this.center.lng,
    };
  }

  getZoom() {
    return this.zoom;
  }

  setCenter(center: { lat: number; lng: number }) {
    this.center = center;
  }

  setZoom(zoom: number) {
    this.zoom = zoom;
  }

  moveCamera(center: { lat: number; lng: number }, zoom: number) {
    this.center = center;
    this.zoom = zoom;
    (this.idleListener as { callback?: () => void } | undefined)?.callback?.();
  }
}

const browserGoogleMaps = {
  Map: MockBrowserMap,
  LatLngBounds: MockBounds,
  Polyline: class {
    setMap() {}
  },
  AdvancedMarkerElement: class {
    map: unknown;
    constructor(options: { map: unknown }) {
      this.map = options.map;
    }
    addListener() {
      return { remove: vi.fn() };
    }
  },
};

function leg(): MapRouteLeg {
  return {
    teamMemberId: 7,
    name: "Casey Cleaner",
    color: null,
    bookingId: 42,
    customerName: "Sarah M.",
    customerAddress: "12 Oak St",
    destLat: 53.56,
    destLng: -113.51,
    scheduledFor: new Date(Date.UTC(2026, 7, 9, 18, 30, 0)).toISOString(),
    etaSeconds: 15 * 60,
    distanceMeters: 8400,
    source: "google",
    path: [
      { lat: 53.54, lng: -113.49 },
      { lat: 53.56, lng: -113.51 },
    ],
  };
}

// A job well north-east of the trail so a trails-only frame would miss it.
function farJob(): MapJob {
  return {
    bookingId: 9,
    customerName: "Priya K.",
    customerAddress: "99 Birch Ave",
    lat: 53.8,
    lng: -113.3,
    scheduledFor: new Date(Date.UTC(2026, 7, 9, 21, 0, 0)).toISOString(),
    status: "confirmed",
    assignees: [],
  };
}

function cleaner(lat: number, lng: number) {
  return {
    teamMemberId: 7,
    name: "Casey Cleaner",
    color: null,
    isOwner: false,
    lat,
    lng,
    deviceId: 17,
  };
}

beforeEach(() => {
  animateToRegion.mockClear();
  setCamera.mockClear();
  getCamera.mockReset();
  vi.spyOn(AppState, "addEventListener").mockImplementation(
    (_event, listener) => {
      signalAppState = listener as (state: string) => void;
      return { remove: vi.fn() };
    },
  );
  signalMapReady = undefined;
  signalRegionChangeComplete = undefined;
  signalNativeMapTeardown = undefined;
  MockBrowserMap.instances = [];
  googleMapsMocks.loadGoogleMaps.mockResolvedValue(browserGoogleMaps);
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("TrailMap opening frame", () => {
  it("waits for both datasets, then frames a region containing both", () => {
    // Routes answered first; jobs still in flight → no framing yet.
    const { rerender } = render(
      <TrailMap
        routes={[leg()]}
        jobs={[]}
        framingReady={false}
        timezone={TZ}
        nowMs={Date.UTC(2026, 7, 9, 18, 0, 0)}
      />,
    );
    expect(animateToRegion).not.toHaveBeenCalled();

    // Jobs land → now frame, once, around trails AND pins.
    rerender(
      <TrailMap
        routes={[leg()]}
        jobs={[farJob()]}
        framingReady={true}
        timezone={TZ}
        nowMs={Date.UTC(2026, 7, 9, 18, 0, 0)}
      />,
    );
    expect(animateToRegion).not.toHaveBeenCalled();
    act(() => signalMapReady?.());
    expect(animateToRegion).toHaveBeenCalledTimes(1);
    const region = animateToRegion.mock.calls[0]![0] as {
      latitude: number;
      longitude: number;
      latitudeDelta: number;
      longitudeDelta: number;
    };
    const north = region.latitude + region.latitudeDelta / 2;
    const south = region.latitude - region.latitudeDelta / 2;
    const east = region.longitude + region.longitudeDelta / 2;
    const west = region.longitude - region.longitudeDelta / 2;
    // Trail start and the far job pin both sit inside the framed box.
    for (const p of [
      { lat: 53.54, lng: -113.49 },
      { lat: 53.8, lng: -113.3 },
    ]) {
      expect(p.lat).toBeGreaterThanOrEqual(south);
      expect(p.lat).toBeLessThanOrEqual(north);
      expect(p.lng).toBeGreaterThanOrEqual(west);
      expect(p.lng).toBeLessThanOrEqual(east);
    }
  });

  it("frames when jobs answer first and trails arrive second", () => {
    const { rerender } = render(
      <TrailMap
        routes={[]}
        jobs={[farJob()]}
        framingReady={false}
        timezone={TZ}
        nowMs={Date.UTC(2026, 7, 9, 18, 0, 0)}
      />,
    );
    expect(animateToRegion).not.toHaveBeenCalled();

    rerender(
      <TrailMap
        routes={[leg()]}
        jobs={[farJob()]}
        framingReady={true}
        timezone={TZ}
        nowMs={Date.UTC(2026, 7, 9, 18, 0, 0)}
      />,
    );
    act(() => signalMapReady?.());
    expect(animateToRegion).toHaveBeenCalledTimes(1);
  });

  it("never re-frames after the first — the rider owns the camera", () => {
    const { rerender } = render(
      <TrailMap
        routes={[leg()]}
        jobs={[farJob()]}
        framingReady={true}
        timezone={TZ}
        nowMs={Date.UTC(2026, 7, 9, 18, 0, 0)}
      />,
    );
    act(() => signalMapReady?.());
    expect(animateToRegion).toHaveBeenCalledTimes(1);

    // A refresh tick moves everything; the camera must not chase it.
    rerender(
      <TrailMap
        routes={[leg()]}
        jobs={[farJob(), { ...farJob(), bookingId: 10, lat: 53.9 }]}
        framingReady={true}
        timezone={TZ}
        nowMs={Date.UTC(2026, 7, 9, 18, 5, 0)}
      />,
    );
    expect(animateToRegion).toHaveBeenCalledTimes(1);
  });

  it("restores the user's camera after rotation while cleaner locations refresh", async () => {
    const camera = {
      center: { latitude: 53.57, longitude: -113.52 },
      pitch: 18,
      heading: 42,
      altitude: 1200,
      zoom: 13,
    };
    let resolveCamera!: (value: typeof camera) => void;
    getCamera.mockReturnValue(
      new Promise<typeof camera>((resolve) => {
        resolveCamera = resolve;
      }),
    );
    const { rerender } = render(
      <TrailMap
        routes={[leg()]}
        jobs={[farJob()]}
        cleaners={[cleaner(53.54, -113.49)]}
        framingReady={true}
        timezone={TZ}
        nowMs={Date.UTC(2026, 7, 9, 18, 0, 0)}
      />,
    );
    act(() => signalMapReady?.());
    expect(animateToRegion).toHaveBeenCalledTimes(1);

    act(() => signalAppState?.("background"));
    expect(getCamera).toHaveBeenCalledTimes(1);
    // The fast native snapshot can finish while the app is still away.
    await act(async () => {
      resolveCamera(camera);
      await Promise.resolve();
    });

    // Rotation can recreate the native MapView while the screen remains
    // mounted. Cleaner polling can also deliver a new location at the same
    // time; neither should cause a new data-driven opening frame.
    rerender(
      <TrailMap
        routes={[leg()]}
        jobs={[{ ...farJob(), lat: 53.81 }]}
        cleaners={[cleaner(53.81, -113.31)]}
        framingReady={true}
        timezone={TZ}
        nowMs={Date.UTC(2026, 7, 9, 18, 5, 0)}
      />,
    );
    act(() => signalAppState?.("active"));
    // The app is active again when the orientation-driven native recreation
    // finishes. Ignore the ordinary foreground restore so this assertion is
    // specifically about the fresh MapView instance.
    setCamera.mockClear();
    // This second ready callback represents the orientation-driven native
    // view recreation. It must restore the complete user-owned camera.
    act(() => signalMapReady?.());
    expect(setCamera).toHaveBeenCalledTimes(1);
    expect(setCamera).toHaveBeenCalledWith({
      center: { latitude: 53.57, longitude: -113.52 },
      zoom: 13,
      heading: 42,
      pitch: 18,
      altitude: 1200,
    });
    // Refreshing the data and recreating the native view must not trigger a
    // second opening frame.
    expect(animateToRegion).toHaveBeenCalledTimes(1);
  });

  it("restores the last camera after a full native teardown and remount", async () => {
    const camera = {
      center: { latitude: 53.61, longitude: -113.45 },
      pitch: 9,
      heading: 128,
      altitude: 900,
      zoom: 14,
    };
    getCamera.mockResolvedValue(camera);
    const { rerender } = render(
      <TrailMap
        routes={[leg()]}
        jobs={[farJob()]}
        cleaners={[cleaner(53.54, -113.49)]}
        framingReady={true}
        timezone={TZ}
        nowMs={Date.UTC(2026, 7, 9, 18, 0, 0)}
      />,
    );
    act(() => signalMapReady?.());
    expect(animateToRegion).toHaveBeenCalledTimes(1);

    // This is the native equivalent of the user moving the camera. The
    // snapshot is taken before the OS tears down the native map instance.
    act(() => signalRegionChangeComplete?.());
    await act(async () => {
      await Promise.resolve();
    });

    // A killed/reopened app can lose the native view while the screen and its
    // camera state remain alive. Cleaner polling may refresh at the same time.
    act(() => signalNativeMapTeardown?.());
    rerender(
      <TrailMap
        routes={[leg()]}
        jobs={[{ ...farJob(), lat: 53.82, lng: -113.28 }]}
        cleaners={[cleaner(53.82, -113.28)]}
        framingReady={true}
        timezone={TZ}
        nowMs={Date.UTC(2026, 7, 9, 18, 5, 0)}
      />,
    );
    setCamera.mockClear();
    act(() => signalMapReady?.());

    expect(setCamera).toHaveBeenCalledTimes(1);
    expect(setCamera).toHaveBeenCalledWith(camera);
    expect(animateToRegion).toHaveBeenCalledTimes(1);
  });

  it("keeps the moved camera after the user query resolves and the Map tab remounts", async () => {
    const camera = {
      center: { latitude: 53.61, longitude: -113.45 },
      pitch: 9,
      heading: 128,
      altitude: 900,
      zoom: 14,
    };
    getCamera.mockResolvedValue(camera);
    const cameraPersistenceKey = "current-user-query-race-test";
    const firstMap = render(
      <TrailMap
        routes={[leg()]}
        jobs={[farJob()]}
        cleaners={[cleaner(53.54, -113.49)]}
        framingReady={true}
        timezone={TZ}
        nowMs={Date.UTC(2026, 7, 9, 18, 0, 0)}
      />,
    );
    act(() => signalMapReady?.());
    expect(animateToRegion).toHaveBeenCalledTimes(1);

    // Map data can arrive before the current-user query. Once the owner email
    // resolves, future gesture snapshots must use that newly available key.
    firstMap.rerender(
      <TrailMap
        routes={[leg()]}
        jobs={[farJob()]}
        cleaners={[cleaner(53.54, -113.49)]}
        framingReady={true}
        timezone={TZ}
        nowMs={Date.UTC(2026, 7, 9, 18, 0, 0)}
        cameraPersistenceKey={cameraPersistenceKey}
      />,
    );

    // A completed gesture is the durable snapshot that must survive leaving
    // the tab. The next location poll is intentionally far from the old view.
    act(() => signalRegionChangeComplete?.());
    await act(async () => {
      await Promise.resolve();
    });
    firstMap.unmount();

    setCamera.mockClear();
    const secondMap = render(
      <TrailMap
        routes={[leg()]}
        jobs={[{ ...farJob(), lat: 53.82, lng: -113.28 }]}
        cleaners={[cleaner(53.82, -113.28)]}
        framingReady={true}
        timezone={TZ}
        nowMs={Date.UTC(2026, 7, 9, 18, 5, 0)}
        cameraPersistenceKey={cameraPersistenceKey}
      />,
    );
    act(() => signalMapReady?.());

    expect(setCamera).toHaveBeenCalledTimes(1);
    expect(setCamera).toHaveBeenCalledWith(camera);
    expect(animateToRegion).toHaveBeenCalledTimes(1);
    secondMap.unmount();
  });

  it("dismisses a timeout error when the native map eventually becomes ready", () => {
    vi.useFakeTimers();
    try {
      render(
        <TrailMap
          routes={[leg()]}
          jobs={[farJob()]}
          framingReady={true}
          timezone={TZ}
          nowMs={Date.UTC(2026, 7, 9, 18, 0, 0)}
        />,
      );

      act(() => vi.advanceTimersByTime(15_000));
      expect(document.body.textContent).toContain(
        "couldn't start the native map",
      );

      act(() => signalMapReady?.());
      expect(document.body.textContent).not.toContain(
        "couldn't start the native map",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("browser TrailMap opening frame", () => {
  it("frames once after both datasets answer and keeps the moved view through refreshes", async () => {
    const cameraPersistenceKey = "browser-map-refresh-test";
    const { rerender } = render(
      <BrowserTrailMap
        routes={[leg()]}
        jobs={[]}
        framingReady={false}
        timezone={TZ}
        nowMs={Date.UTC(2026, 7, 9, 18, 0, 0)}
        cameraPersistenceKey={cameraPersistenceKey}
        apiKey="test-key"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    const map = MockBrowserMap.instances[0]!;
    expect(map.fitBounds).not.toHaveBeenCalled();

    rerender(
      <BrowserTrailMap
        routes={[leg()]}
        jobs={[farJob()]}
        cleaners={[cleaner(53.54, -113.49)]}
        framingReady={true}
        timezone={TZ}
        nowMs={Date.UTC(2026, 7, 9, 18, 0, 0)}
        cameraPersistenceKey={cameraPersistenceKey}
        apiKey="test-key"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(map.fitBounds).toHaveBeenCalledTimes(1);
    const firstBounds = map.fitBounds.mock.calls[0]![0] as MockBounds;
    expect(firstBounds.points).toEqual(
      expect.arrayContaining([
        { lat: 53.54, lng: -113.49 },
        { lat: 53.8, lng: -113.3 },
      ]),
    );

    // Simulate a browser pan/zoom, then let every polled dataset change.
    map.moveCamera({ lat: 53.61, lng: -113.45 }, 14);
    rerender(
      <BrowserTrailMap
        routes={[{ ...leg(), destLat: 53.62 }]}
        jobs={[{ ...farJob(), lat: 53.82, lng: -113.28 }]}
        cleaners={[cleaner(53.82, -113.28)]}
        framingReady={true}
        timezone={TZ}
        nowMs={Date.UTC(2026, 7, 9, 18, 5, 0)}
        cameraPersistenceKey={cameraPersistenceKey}
        apiKey="test-key"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(map.fitBounds).toHaveBeenCalledTimes(1);
    expect(map.getCenter()).toEqual({
      lat: expect.any(Function),
      lng: expect.any(Function),
    });
    expect(map.getCenter().lat()).toBe(53.61);
    expect(map.getCenter().lng()).toBe(-113.45);
    expect(map.getZoom()).toBe(14);
  });

  it("restores a moved browser camera when the map tab remounts", async () => {
    const cameraPersistenceKey = "browser-map-remount-test";
    const first = render(
      <BrowserTrailMap
        routes={[leg()]}
        jobs={[farJob()]}
        framingReady={true}
        timezone={TZ}
        nowMs={Date.UTC(2026, 7, 9, 18, 0, 0)}
        cameraPersistenceKey={cameraPersistenceKey}
        apiKey="test-key"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const firstMap = MockBrowserMap.instances[0]!;
    firstMap.moveCamera({ lat: 53.61, lng: -113.45 }, 14);
    first.unmount();

    render(
      <BrowserTrailMap
        routes={[]}
        jobs={[{ ...farJob(), lat: 53.82, lng: -113.28 }]}
        framingReady={true}
        timezone={TZ}
        nowMs={Date.UTC(2026, 7, 9, 18, 5, 0)}
        cameraPersistenceKey={cameraPersistenceKey}
        apiKey="test-key"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const secondMap = MockBrowserMap.instances[1]!;
    expect(secondMap.fitBounds).not.toHaveBeenCalled();
    expect(secondMap.getCenter().lat()).toBe(53.61);
    expect(secondMap.getCenter().lng()).toBe(-113.45);
    expect(secondMap.getZoom()).toBe(14);
  });
});
