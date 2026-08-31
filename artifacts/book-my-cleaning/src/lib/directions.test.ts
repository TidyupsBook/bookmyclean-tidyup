import { describe, it, expect } from "vitest";
import { fullAddress, directionsUrl, telHref } from "./directions";

describe("fullAddress", () => {
  it("puts the unit line between the street and locality", () => {
    expect(
      fullAddress({
        customerAddress: "123 Main St",
        addressLine2: "Unit 204",
        addressCity: "Edmonton",
        addressProvince: "AB",
        addressPostal: "T5J 0N3",
      }),
    ).toBe("123 Main St, Unit 204, Edmonton, AB, T5J 0N3");
  });

  it("reads out the parts we have and skips the ones we don't", () => {
    expect(
      fullAddress({
        customerAddress: "5810 Mullen Place",
        addressCity: "Edmonton",
        addressProvince: "AB",
        addressPostal: null,
      }),
    ).toBe("5810 Mullen Place, Edmonton, AB");
  });

  it("is empty when nothing was ever collected", () => {
    expect(fullAddress({ customerAddress: "   ", addressCity: null })).toBe("");
  });
});

describe("directionsUrl", () => {
  it("drives to the pin when the booking has been located", () => {
    expect(
      directionsUrl({
        customerAddress: "660 Cedar Court",
        lat: 53.5461,
        lng: -113.4938,
      }),
    ).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=53.5461,-113.4938",
    );
  });

  it("falls back to the written address when there is no pin", () => {
    expect(
      directionsUrl({
        customerAddress: "5810 Mullen Place",
        addressCity: "Edmonton",
        addressProvince: "AB",
      }),
    ).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=5810%20Mullen%20Place%2C%20Edmonton%2C%20AB",
    );
  });

  it("offers nothing rather than guessing at a street with no city", () => {
    // "660 Cedar Court" exists in a lot of places. Sending the van to the
    // wrong one is worse than making the dispatcher look it up.
    expect(directionsUrl({ customerAddress: "660 Cedar Court" })).toBeNull();
    expect(directionsUrl({ customerAddress: null })).toBeNull();
  });
});

describe("telHref", () => {
  it("strips the punctuation a dispatcher typed", () => {
    expect(telHref("(780) 718-5092")).toBe("tel:7807185092");
  });

  it("keeps a country code", () => {
    expect(telHref("+1 780 718 5092")).toBe("tel:+17807185092");
  });

  it("refuses a number too short to dial", () => {
    expect(telHref("718")).toBeNull();
    expect(telHref(null)).toBeNull();
  });
});
