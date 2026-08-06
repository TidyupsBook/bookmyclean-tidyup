import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

import {
  geocodeAddress,
  setGeocoder,
  resetGeocoder,
  clearGeocodeCache,
  GeocodeConfigError,
  type Geocoder,
} from "./geocode";

afterEach(() => {
  resetGeocoder();
  clearGeocodeCache();
});

describe("geocodeAddress with an injected stub", () => {
  it("returns the stub's coordinates", async () => {
    setGeocoder(async () => ({ lat: 51.05, lng: -114.07 }));
    const result = await geocodeAddress("123 Anywhere");
    expect(result).toEqual({ lat: 51.05, lng: -114.07 });
  });

  it("returns null when the stub cannot place the address", async () => {
    // Google almost never returns ZERO_RESULTS, so the negative path is only
    // reachable by injecting a stub — never by relying on a fake address.
    setGeocoder(async () => null);
    const result = await geocodeAddress("nowhere at all");
    expect(result).toBeNull();
  });

  it("re-throws a config error so callers can back off on a dead key", async () => {
    setGeocoder(async () => {
      throw new GeocodeConfigError("REQUEST_DENIED");
    });
    await expect(geocodeAddress("123 Anywhere")).rejects.toBeInstanceOf(
      GeocodeConfigError,
    );
  });

  it("caches a resolved address so the geocoder runs once", async () => {
    const stub = vi.fn<Geocoder>(async () => ({ lat: 1, lng: 2 }));
    setGeocoder(stub);
    await geocodeAddress("10 Cache St");
    await geocodeAddress("10 CACHE st  "); // normalized to the same key
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("does not cache a transient failure", async () => {
    let calls = 0;
    setGeocoder(async () => {
      calls++;
      if (calls === 1) throw new Error("network blip");
      return { lat: 3, lng: 4 };
    });
    await expect(geocodeAddress("5 Retry Rd")).rejects.toThrow("network blip");
    const result = await geocodeAddress("5 Retry Rd");
    expect(result).toEqual({ lat: 3, lng: 4 });
  });
});
