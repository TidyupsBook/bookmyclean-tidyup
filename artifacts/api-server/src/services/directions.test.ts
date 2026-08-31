import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDrivingRoute,
  estimateRoute,
  setDirectionsProvider,
  resetDirectionsProvider,
  clearDirectionsCache,
  type DrivingRoute,
} from "./directions";

const ORIGIN = { lat: 53.5461, lng: -113.4938 };
const DEST = { lat: 53.56, lng: -113.51 };

const fakeRoute: DrivingRoute = {
  etaSeconds: 600,
  distanceMeters: 4200,
  path: [ORIGIN, DEST],
  source: "google",
};

beforeEach(() => {
  clearDirectionsCache();
  resetDirectionsProvider();
});

afterEach(() => {
  resetDirectionsProvider();
  clearDirectionsCache();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("getDrivingRoute caching", () => {
  it("serves a barely-moved cleaner from cache", async () => {
    const provider = vi.fn(async () => fakeRoute);
    setDirectionsProvider(provider);

    await getDrivingRoute("1:1", ORIGIN, DEST);
    // ~55 m north — parked at a light, not a new route.
    const nudged = { lat: ORIGIN.lat + 0.0005, lng: ORIGIN.lng };
    const again = await getDrivingRoute("1:1", nudged, DEST);

    expect(provider).toHaveBeenCalledTimes(1);
    expect(again).toEqual(fakeRoute);
  });

  it("re-asks once the cleaner has really moved", async () => {
    const provider = vi.fn(async () => fakeRoute);
    setDirectionsProvider(provider);

    await getDrivingRoute("1:1", ORIGIN, DEST);
    // ~330 m — the cached line no longer starts where the car is.
    const moved = { lat: ORIGIN.lat + 0.003, lng: ORIGIN.lng };
    await getDrivingRoute("1:1", moved, DEST);

    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("re-asks when the destination changes", async () => {
    const provider = vi.fn(async () => fakeRoute);
    setDirectionsProvider(provider);

    await getDrivingRoute("1:1", ORIGIN, DEST);
    await getDrivingRoute("1:1", ORIGIN, { lat: 53.6, lng: -113.4 });

    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("re-asks after the route has aged out", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-09T18:00:00Z") });
    const provider = vi.fn(async () => fakeRoute);
    setDirectionsProvider(provider);

    await getDrivingRoute("1:1", ORIGIN, DEST);
    vi.advanceTimersByTime(4 * 60_000);
    await getDrivingRoute("1:1", ORIGIN, DEST);

    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("goes quiet for a minute after a failure instead of hammering", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-09T18:00:00Z") });
    const provider = vi.fn(async () => null);
    setDirectionsProvider(provider);

    expect(await getDrivingRoute("1:1", ORIGIN, DEST)).toBeNull();
    expect(await getDrivingRoute("1:1", ORIGIN, DEST)).toBeNull();
    expect(provider).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    await getDrivingRoute("1:1", ORIGIN, DEST);
    expect(provider).toHaveBeenCalledTimes(2);
  });
});

describe("google provider parsing", () => {
  it("decodes a healthy Directions answer", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          status: "OK",
          routes: [
            {
              overview_polyline: { points: "_p~iF~ps|U_ulLnnqC_mqNvxq`@" },
              legs: [{ duration: { value: 754 }, distance: { value: 5210 } }],
            },
          ],
        }),
      })),
    );

    const route = await getDrivingRoute("parse:1", ORIGIN, DEST);
    expect(route).not.toBeNull();
    expect(route!.source).toBe("google");
    expect(route!.etaSeconds).toBe(754);
    expect(route!.distanceMeters).toBe(5210);
    expect(route!.path).toHaveLength(3);
    expect(route!.path[0]!.lat).toBeCloseTo(38.5, 5);
  });

  it("marks the key dead on REQUEST_DENIED and stops calling out", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "REQUEST_DENIED",
        error_message: "This API key is not authorized",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await getDrivingRoute("denied:1", ORIGIN, DEST)).toBeNull();
    // A different cleaner: the per-key quiet period doesn't apply, but the
    // config-dead flag does — no second HTTP call.
    expect(await getDrivingRoute("denied:2", ORIGIN, DEST)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("estimateRoute", () => {
  it("labels itself and draws a straight line", () => {
    const est = estimateRoute(ORIGIN, DEST);
    expect(est.source).toBe("estimate");
    expect(est.path).toEqual([ORIGIN, DEST]);
    expect(est.etaSeconds).toBeGreaterThanOrEqual(5 * 60);
    expect(est.distanceMeters).toBeGreaterThan(0);
  });
});
