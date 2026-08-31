import { describe, it, expect } from "vitest";
import { composeBookingAddress } from "./bookingAddress";

const parts = (over: Partial<Parameters<typeof composeBookingAddress>[0]>) => ({
  street: "",
  city: "",
  province: "",
  postal: "",
  ...over,
});

describe("composeBookingAddress", () => {
  it("waits until the street line looks like a street", () => {
    expect(composeBookingAddress(parts({ street: "581" }))).toBeNull();
    expect(composeBookingAddress(parts({ street: "5810 " }))).toBeNull();
    // Digits alone are the start of an address, never one.
    expect(composeBookingAddress(parts({ street: "58101234" }))).toBeNull();
  });

  it("always carries the region so a repeated street name can't drift", () => {
    expect(
      composeBookingAddress(parts({ street: "17115 61 Ave", province: "AB" })),
    ).toBe("17115 61 Ave, AB");
  });

  it("joins street, city and region into one line", () => {
    expect(
      composeBookingAddress(
        parts({
          street: "5810 Mullen Place",
          city: "Edmonton",
          province: "AB",
          postal: "t6r 0w3",
        }),
      ),
    ).toBe("5810 Mullen Place, Edmonton, AB T6R 0W3");
  });

  it("collapses stray whitespace so the same address is one lookup", () => {
    expect(
      composeBookingAddress(
        parts({ street: "  5810   Mullen  Place ", city: " Edmonton " }),
      ),
    ).toBe("5810 Mullen Place, Edmonton");
  });
});
