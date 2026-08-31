/**
 * Address suggestions, and specifically what happens when Google says no.
 *
 * The bug these guard against is silence: the browser used to ask Google
 * directly, and a key without Places API (New) produced an empty dropdown with
 * nothing in any log. Asking from the server means a refusal has to turn into
 * either the older endpoint or an honest "suggestions are off".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

import { suggestAddresses, resetSuggestionState } from "./placeSuggestions";

const originalFetch = globalThis.fetch;
const originalPlacesKey = process.env["PLACES_API1"];
const originalMapsKey = process.env["GOOGLE_MAPS_API_KEY"];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  resetSuggestionState();
  delete process.env["PLACES_API1"];
  process.env["GOOGLE_MAPS_API_KEY"] = "test-key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalPlacesKey === undefined) delete process.env["PLACES_API1"];
  else process.env["PLACES_API1"] = originalPlacesKey;
  if (originalMapsKey === undefined) delete process.env["GOOGLE_MAPS_API_KEY"];
  else process.env["GOOGLE_MAPS_API_KEY"] = originalMapsKey;
  resetSuggestionState();
});

describe("when the new Places API is blocked on this key", () => {
  it("falls back to the older endpoint instead of returning nothing", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("places.googleapis.com")) {
        return jsonResponse(403, {
          error: { status: "PERMISSION_DENIED" },
        });
      }
      return jsonResponse(200, {
        status: "OK",
        predictions: [
          {
            place_id: "p1",
            description: "5810 Mullen Place, Edmonton, AB, Canada",
            structured_formatting: {
              main_text: "5810 Mullen Place",
              secondary_text: "Edmonton, AB, Canada",
            },
          },
        ],
      });
    }) as unknown as typeof fetch;

    const result = await suggestAddresses("5810 Mullen");

    expect(result.available).toBe(true);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]!.primary).toBe("5810 Mullen Place");
    expect(result.suggestions[0]!.full).toContain("Edmonton");
    expect(calls[0]).toContain("places.googleapis.com");
    expect(calls[1]).toContain("maps.googleapis.com");
  });

  it("stops re-asking the blocked endpoint on every keystroke", async () => {
    let newApiCalls = 0;
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("places.googleapis.com")) {
        newApiCalls++;
        return jsonResponse(403, { error: { status: "PERMISSION_DENIED" } });
      }
      return jsonResponse(200, { status: "OK", predictions: [] });
    }) as unknown as typeof fetch;

    await suggestAddresses("123 Main");
    await suggestAddresses("123 Main S");
    await suggestAddresses("123 Main St");

    expect(newApiCalls).toBe(1);
  });
});

describe("when the key has no Places access at all", () => {
  it("reports suggestions as unavailable rather than empty", async () => {
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("places.googleapis.com")) {
        return jsonResponse(403, { error: { status: "PERMISSION_DENIED" } });
      }
      // The legacy endpoint refuses in the body, with HTTP 200.
      return jsonResponse(200, {
        status: "REQUEST_DENIED",
        error_message: "This API project is not authorized.",
      });
    }) as unknown as typeof fetch;

    const result = await suggestAddresses("123 Main");

    expect(result.available).toBe(false);
    expect(result.suggestions).toEqual([]);
  });
});

describe("the dedicated Places key", () => {
  it("is used ahead of the map key when one is configured", async () => {
    process.env["PLACES_API1"] = "places-only-key";
    const seenKeys: string[] = [];
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      seenKeys.push(String(init?.headers?.["X-Goog-Api-Key"] ?? input));
      return jsonResponse(200, { suggestions: [] });
    }) as unknown as typeof fetch;

    await suggestAddresses("123 Main");

    expect(seenKeys[0]).toBe("places-only-key");
  });
});

describe("the Canada restriction and Edmonton default", () => {
  it("restricts the new API to Canada and biases to Edmonton when no bias is given", async () => {
    let payload: any;
    globalThis.fetch = vi.fn(async (_input: any, init: any) => {
      payload = JSON.parse(String(init?.body));
      return jsonResponse(200, { suggestions: [] });
    }) as unknown as typeof fetch;

    await suggestAddresses("123 Main St");

    expect(payload.includedRegionCodes).toEqual(["ca"]);
    expect(payload.locationBias.circle.center).toEqual({
      latitude: 53.5461,
      longitude: -113.4938,
    });
  });

  it("keeps a caller-supplied bias ahead of the Edmonton default", async () => {
    let payload: any;
    globalThis.fetch = vi.fn(async (_input: any, init: any) => {
      payload = JSON.parse(String(init?.body));
      return jsonResponse(200, { suggestions: [] });
    }) as unknown as typeof fetch;

    await suggestAddresses("123 Main St", { lat: 51.05, lng: -114.07 });

    expect(payload.includedRegionCodes).toEqual(["ca"]);
    expect(payload.locationBias.circle.center).toEqual({
      latitude: 51.05,
      longitude: -114.07,
    });
  });

  it("restricts the legacy endpoint to Canada with the same default bias", async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("places.googleapis.com")) {
        return jsonResponse(403, { error: { status: "PERMISSION_DENIED" } });
      }
      return jsonResponse(200, { status: "OK", predictions: [] });
    }) as unknown as typeof fetch;

    await suggestAddresses("123 Main St");

    const legacy = urls.find((u) => u.includes("maps.googleapis.com"));
    expect(legacy).toBeTruthy();
    const params = new URL(legacy!).searchParams;
    expect(params.get("components")).toBe("country:ca");
    expect(params.get("location")).toBe("53.5461,-113.4938");
  });
});

describe("short input", () => {
  it("never reaches Google", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(200, {}));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await suggestAddresses("12");

    expect(result).toEqual({ suggestions: [], available: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
