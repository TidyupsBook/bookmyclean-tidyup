import { describe, it, expect } from "vitest";
import {
  countryFromTimeZone,
  regionSettings,
  CA_PROVINCES,
  US_STATES,
} from "./region";

describe("countryFromTimeZone", () => {
  it("keeps every Canadian zone — and anything unknown — on Canada", () => {
    for (const tz of [
      "America/Edmonton",
      "America/Toronto",
      "America/Vancouver",
      "America/Winnipeg",
      "America/Halifax",
      "America/St_Johns",
      "America/Regina",
      "Europe/London",
      "",
      undefined,
      null,
    ]) {
      expect(countryFromTimeZone(tz)).toBe("CA");
    }
  });

  it("recognises US zones", () => {
    for (const tz of [
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Phoenix",
      "America/Los_Angeles",
      "America/Anchorage",
      "Pacific/Honolulu",
      "America/Indiana/Indianapolis",
      "America/Kentucky/Louisville",
      "America/North_Dakota/Center",
      "US/Eastern",
    ]) {
      expect(countryFromTimeZone(tz)).toBe("US");
    }
  });
});

describe("regionSettings", () => {
  it("offers provinces to a Canadian company, unchanged", () => {
    const s = regionSettings("CA");
    expect(s.regions).toBe(CA_PROVINCES);
    expect(s.defaultRegion).toBe("AB");
    expect(s.regionLabel).toBe("Province");
    expect(s.postalLabel).toBe("Postal code");
  });

  it("offers all 50 states plus DC to a US company", () => {
    const s = regionSettings("US");
    expect(s.regions).toBe(US_STATES);
    expect(US_STATES).toHaveLength(51);
    expect(s.regionLabel).toBe("State");
    expect(s.postalLabel).toBe("ZIP code");
    expect(US_STATES).toContain(s.defaultRegion);
  });
});
