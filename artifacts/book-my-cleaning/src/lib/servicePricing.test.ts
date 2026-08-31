import { describe, expect, it } from "vitest";
import { exactServicePrice } from "./servicePricing";

describe("exactServicePrice", () => {
  it("returns a fixed service price with whitespace and case ignored", () => {
    expect(
      exactServicePrice(
        [{ name: "Move-Out Cleaning", priceMin: 400, priceMax: 400 }],
        " move-out cleaning ",
      ),
    ).toBe(400);
  });

  it("does not invent a price for an unpriced service or a range", () => {
    expect(
      exactServicePrice(
        [
          { name: "Steam Cleaning", priceMin: null, priceMax: null },
          { name: "Deep Cleaning", priceMin: 200, priceMax: 400 },
        ],
        "Steam Cleaning",
      ),
    ).toBeNull();
    expect(
      exactServicePrice(
        [{ name: "Deep Cleaning", priceMin: 200, priceMax: 400 }],
        "Deep Cleaning",
      ),
    ).toBeNull();
  });
});
