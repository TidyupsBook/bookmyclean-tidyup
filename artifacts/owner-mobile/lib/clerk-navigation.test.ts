import { describe, expect, it } from "vitest";
import { clerkAppDestination } from "./clerk-navigation";

describe("clerkAppDestination", () => {
  it("keeps decorated navigation on the browser's current origin", () => {
    expect(
      clerkAppDestination(
        "https://shared-preview.example/leads?__clerk_synced=true#ready",
        "https://mobile.expo.example",
      ),
    ).toBe("/leads?__clerk_synced=true#ready");
  });

  it("resolves relative destinations without changing their route", () => {
    expect(
      clerkAppDestination("/leads?source=sheet", "https://mobile.expo.example"),
    ).toBe("/leads?source=sheet");
  });

  it("leaves native destinations unchanged", () => {
    expect(clerkAppDestination("owner-mobile://leads")).toBe(
      "owner-mobile://leads",
    );
  });
});
