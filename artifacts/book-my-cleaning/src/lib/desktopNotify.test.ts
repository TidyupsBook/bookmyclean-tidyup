import { describe, expect, it } from "vitest";
import { shouldPopUp } from "./desktopNotify";

describe("shouldPopUp", () => {
  it("pops up for someone working in another window", () => {
    expect(shouldPopUp("granted", true)).toBe(true);
  });

  it("stays quiet while the app is on screen", () => {
    // The toast is already saying it; a second copy over the top is noise.
    expect(shouldPopUp("granted", false)).toBe(false);
  });

  it("never pops up without permission", () => {
    expect(shouldPopUp("default", true)).toBe(false);
    expect(shouldPopUp("denied", true)).toBe(false);
    expect(shouldPopUp("unsupported", true)).toBe(false);
  });
});
