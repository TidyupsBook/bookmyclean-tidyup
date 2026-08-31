import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

import {
  geocodeAddress,
  geocodeCacheKey,
  googleGeocoder,
  normalizeAddress,
  setGeocoder,
  resetGeocoder,
  clearGeocodeCache,
  EDMONTON_BIAS,
  GeocodeConfigError,
  type Geocoder,
  type GeocodeBias,
} from "./geocode";

const originalFetch = globalThis.fetch;
const originalMapsKey = process.env["GOOGLE_MAPS_API_KEY"];

afterEach(() => {
  resetGeocoder();
  clearGeocodeCache();
  globalThis.fetch = originalFetch;
  if (originalMapsKey === undefined) delete process.env["GOOGLE_MAPS_API_KEY"];
  else process.env["GOOGLE_MAPS_API_KEY"] = originalMapsKey;
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

  it("defaults the bias to Edmonton when the caller passes none", async () => {
    let seen: GeocodeBias | undefined;
    setGeocoder(async (_address, bias) => {
      seen = bias;
      return { lat: 1, lng: 2 };
    });
    await geocodeAddress("12 Anywhere Ave");
    expect(seen).toEqual(EDMONTON_BIAS);
  });

  it("keeps a caller-supplied bias ahead of the Edmonton default", async () => {
    let seen: GeocodeBias | undefined;
    setGeocoder(async (_address, bias) => {
      seen = bias;
      return { lat: 1, lng: 2 };
    });
    await geocodeAddress("12 Anywhere Ave", { lat: 51.05, lng: -114.07 });
    expect(seen).toEqual({ lat: 51.05, lng: -114.07 });
  });
});

describe("the Canada restriction", () => {
  it("sends the country filter (and default bias bounds) to Google", async () => {
    process.env["GOOGLE_MAPS_API_KEY"] = "test-key";
    let url = "";
    globalThis.fetch = vi.fn(async (input: any) => {
      url = String(input);
      return new Response(JSON.stringify({ status: "ZERO_RESULTS" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await googleGeocoder("123 Main St", EDMONTON_BIAS);

    // The hard filter, not just a preference: no US match can come back.
    expect(url).toContain("components=country:CA");
    // The bias box is still there so ambiguous Canadian streets lean local.
    expect(url).toContain("bounds=");
  });

  it("keys the persistent cache with the restriction so old entries re-resolve", () => {
    // Rows written before lookups were locked to Canada used the bare
    // normalized address; the new key never matches them, so a cached US
    // result (or a cached miss) is looked up again instead of replayed.
    expect(geocodeCacheKey(" 12 Main St ")).toBe("ca:12 main st");
    expect(geocodeCacheKey("12 Main St")).not.toBe(
      normalizeAddress("12 Main St"),
    );
  });
});
