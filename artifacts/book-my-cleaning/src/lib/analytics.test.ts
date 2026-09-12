// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackEvent } from "./analytics";

describe("trackEvent", () => {
  afterEach(() => {
    delete window.umami;
  });

  it("sends an event and its non-PII dimensions to Umami", () => {
    const track = vi.fn();
    window.umami = { track };

    trackEvent("quote_sent", {
      used_catalog_price: true,
      price_mismatch_confirmed: false,
    });

    expect(track).toHaveBeenCalledWith("quote_sent", {
      used_catalog_price: true,
      price_mismatch_confirmed: false,
    });
  });

  it("is a safe no-op when analytics is unavailable", () => {
    expect(() => trackEvent("booking_saved")).not.toThrow();
  });

  it("swallows tracker failures", () => {
    window.umami = {
      track: () => {
        throw new Error("tracker unavailable");
      },
    };

    expect(() => trackEvent("jobber_sync_completed")).not.toThrow();
  });
});
