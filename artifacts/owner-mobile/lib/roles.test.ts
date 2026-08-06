import { describe, expect, it } from "vitest";
import { canSeeBusinessDetails } from "./roles";

describe("canSeeBusinessDetails", () => {
  it("hides pricing and Jobber state from cleaners", () => {
    expect(canSeeBusinessDetails("cleaner")).toBe(false);
  });

  it("shows business details to owners and dispatchers", () => {
    expect(canSeeBusinessDetails("owner")).toBe(true);
    expect(canSeeBusinessDetails("dispatcher")).toBe(true);
  });

  it("defaults closed while the role is unknown", () => {
    expect(canSeeBusinessDetails(undefined)).toBe(false);
  });
});
