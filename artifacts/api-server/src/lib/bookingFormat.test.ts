import { describe, expect, it } from "vitest";
import { joinAddress } from "./bookingFormat";

describe("joinAddress", () => {
  it("places an optional unit line after the street", () => {
    expect(
      joinAddress({
        customerAddress: "123 Main St",
        addressLine2: "Suite 4",
        addressCity: "Edmonton",
        addressProvince: "AB",
        addressPostal: "T5J 0N3",
      }),
    ).toBe("123 Main St, Suite 4, Edmonton, AB, T5J 0N3");
  });

  it("preserves legacy addresses without a unit line", () => {
    expect(
      joinAddress({
        customerAddress: "123 Main St",
        addressLine2: null,
        addressCity: "Edmonton",
        addressProvince: "AB",
        addressPostal: "T5J 0N3",
      }),
    ).toBe("123 Main St, Edmonton, AB, T5J 0N3");
  });
});
