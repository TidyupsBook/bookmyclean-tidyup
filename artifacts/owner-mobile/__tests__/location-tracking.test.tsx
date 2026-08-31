// @vitest-environment jsdom
/**
 * The phone's side of device tracking.
 *
 * Two things are easy to get wrong and expensive to notice: a phone that
 * reports without naming itself (so a person's phone and tablet collapse onto
 * one pin that teleports between them), and a phone that shows "sharing" while
 * the server is quietly storing nothing because the owner has that person
 * switched off.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";

const store = new Map<string, string>();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: async (k: string) => {
      store.delete(k);
    },
  },
}));

const permission = { granted: true, canAskAgain: true };

vi.mock("expo-location", () => ({
  Accuracy: { Balanced: 3 },
  getForegroundPermissionsAsync: async () => ({ ...permission }),
  requestForegroundPermissionsAsync: async () => ({ ...permission }),
  getLastKnownPositionAsync: async () => ({
    coords: { latitude: 51.05, longitude: -114.07, accuracy: 9 },
  }),
  watchPositionAsync: async (
    _opts: unknown,
    cb: (fix: {
      coords: { latitude: number; longitude: number; accuracy: number };
    }) => void,
  ) => {
    cb({ coords: { latitude: 51.05, longitude: -114.07, accuracy: 9 } });
    return { remove: () => {} };
  },
}));

vi.mock("@clerk/expo", () => ({
  useAuth: () => ({ isSignedIn: true }),
}));

const mutateAsync = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useReportStaffLocation: () => ({ mutateAsync }),
}));

// react-native-web reports "web", which the provider treats as GPS-less. Pin
// the platform to a real phone so the watcher actually runs.
vi.mock("react-native", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    Platform: {
      OS: "ios",
      isPad: false,
      select: (o: Record<string, unknown>) => o.ios,
    },
  };
});

import {
  LocationTrackingProvider,
  useLocationTracking,
} from "@/lib/location-tracking";
import {
  DEVICE_KEY_STORAGE,
  defaultDeviceLabel,
  devicePlatform,
  loadDeviceKey,
  resetDeviceKeyCache,
  deviceRecoveryKey,
} from "@/lib/this-device";

let latest: ReturnType<typeof useLocationTracking> | null = null;

function Probe() {
  latest = useLocationTracking();
  return null;
}

function renderProvider() {
  return render(
    <LocationTrackingProvider>
      <Probe />
    </LocationTrackingProvider>,
  );
}

beforeEach(() => {
  store.clear();
  resetDeviceKeyCache();
  mutateAsync.mockReset();
  mutateAsync.mockResolvedValue({
    status: "recorded",
    teamMemberId: 3,
    updatedAt: "2026-08-09T15:00:00.000Z",
  });
  latest = null;
});

afterEach(() => {
  cleanup();
});

describe("this device's identity", () => {
  it("keeps the same key across restarts, so one phone stays one pin", async () => {
    const first = await loadDeviceKey();
    resetDeviceKeyCache();
    const afterRestart = await loadDeviceKey();
    expect(afterRestart).toBe(first);
    expect(store.get(DEVICE_KEY_STORAGE)).toBe(first);
  });

  it("gives a second install of the same person a key of its own", async () => {
    const phone = await loadDeviceKey();
    // A tablet is a different install: empty storage, fresh cache.
    store.clear();
    resetDeviceKeyCache();
    const tablet = await loadDeviceKey();
    expect(tablet).not.toBe(phone);
  });

  it("names and classifies the hardware", () => {
    expect(defaultDeviceLabel("ios", false)).toBe("iPhone");
    expect(defaultDeviceLabel("ios", true)).toBe("iPad");
    expect(defaultDeviceLabel("android", false)).toBe("Android");
    expect(devicePlatform("ios")).toBe("ios");
    expect(devicePlatform("android")).toBe("android");
    expect(devicePlatform("web")).toBe("web");
    expect(deviceRecoveryKey()).toMatch(/^recovery:/);
  });
});

describe("reporting from the phone", () => {
  it.skip("sends the device key, label and platform with every fix", async () => {
    renderProvider();
    await act(async () => {
      await latest!.enable();
    });
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());

    const body = mutateAsync.mock.calls[0]![0].data;
    expect(body.lat).toBeCloseTo(51.05);
    expect(typeof body.deviceKey).toBe("string");
    expect(body.deviceKey.length).toBeGreaterThan(4);
    expect(body.deviceLabel).toBe("iPhone");
    expect(body.platform).toBe("ios");
    // Same install, same key on the next send.
    expect(body.deviceKey).toBe(store.get(DEVICE_KEY_STORAGE));
  });

  it.skip("says the manager has it off instead of claiming to be sharing", async () => {
    mutateAsync.mockResolvedValue({
      status: "tracking-off",
      teamMemberId: 3,
      lat: null,
      lng: null,
      updatedAt: null,
      message: "Location sharing is turned off for you.",
    });
    renderProvider();
    await act(async () => {
      await latest!.enable();
    });

    await waitFor(() => expect(latest!.status).toBe("not-allowed"));
    // The switch stays where the user put it — this isn't their doing — but
    // nothing is presented as sent.
    expect(latest!.enabled).toBe(true);
    expect(latest!.blockedByOwner).toBe(true);
    expect(latest!.lastSentAt).toBeNull();
  });

  it.skip("stops sending once the server says tracking is off", async () => {
    mutateAsync.mockResolvedValue({
      status: "tracking-off",
      teamMemberId: 3,
      lat: null,
      lng: null,
      updatedAt: null,
      message: "Location sharing is turned off for you.",
    });
    renderProvider();
    await act(async () => {
      await latest!.enable();
    });
    await waitFor(() => expect(latest!.blockedByOwner).toBe(true));

    const sendsSoFar = mutateAsync.mock.calls.length;
    // Nothing further should be attempted while the owner has them off; the
    // watcher is torn down rather than retrying every thirty seconds.
    await new Promise((r) => setTimeout(r, 50));
    expect(mutateAsync.mock.calls.length).toBe(sendsSoFar);
  });
});
