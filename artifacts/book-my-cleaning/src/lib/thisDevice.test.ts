import { describe, expect, it } from "vitest";
import { buildDeviceRecoveryKey } from "./thisDevice";
import {
  defaultDeviceName,
  detectPlatform,
  deviceKeyStorageKey,
  isHandheld,
  shouldPrompt,
} from "./thisDevice";

const DESKTOP =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139 Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPAD =
  "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139 Mobile Safari/537.36";

describe("defaultDeviceName", () => {
  it("calls the boss's desktop 'Boss PC'", () => {
    expect(defaultDeviceName({ isOwner: true, userAgent: DESKTOP })).toBe(
      "Boss PC",
    );
  });

  it("tells the boss's own handhelds apart", () => {
    expect(defaultDeviceName({ isOwner: true, userAgent: IPHONE })).toBe(
      "Boss iPhone",
    );
    expect(defaultDeviceName({ isOwner: true, userAgent: IPAD })).toBe(
      "Boss iPad",
    );
    expect(defaultDeviceName({ isOwner: true, userAgent: ANDROID })).toBe(
      "Boss Android",
    );
  });

  it("doesn't call a cleaner's machine the boss's", () => {
    expect(defaultDeviceName({ isOwner: false, userAgent: DESKTOP })).toBe(
      "Computer",
    );
    expect(defaultDeviceName({ isOwner: false, userAgent: IPHONE })).toBe(
      "iPhone",
    );
  });
});

describe("detectPlatform", () => {
  it("reads the obvious families", () => {
    expect(detectPlatform(IPHONE)).toBe("ios");
    expect(detectPlatform(IPAD)).toBe("ios");
    expect(detectPlatform(ANDROID)).toBe("android");
    expect(detectPlatform(DESKTOP)).toBe("web");
  });

  it("knows a handheld from a desk", () => {
    expect(isHandheld(DESKTOP)).toBe(false);
    expect(isHandheld(ANDROID)).toBe(true);
  });
});

describe("deviceKeyStorageKey", () => {
  it("is per signed-in person, so a shared machine doesn't share a pin", () => {
    expect(deviceKeyStorageKey("a@x.test")).not.toBe(
      deviceKeyStorageKey("b@x.test"),
    );
  });
});

describe("device recovery identity", () => {
  it("is deterministic without using coordinates or account data", () => {
    const bits = ["Mozilla/5.0", "en-CA", "MacIntel", "8", "1440x900", "UTC"];
    expect(buildDeviceRecoveryKey(bits)).toBe(buildDeviceRecoveryKey(bits));
    expect(buildDeviceRecoveryKey(bits)).not.toContain("1440");
    expect(buildDeviceRecoveryKey(bits)).not.toContain("en-CA");
  });
});

describe("shouldPrompt", () => {
  it("never asks a browser that has already answered", () => {
    expect(shouldPrompt("granted", false)).toBe(false);
    // The important one: a denied browser wouldn't show the dialog anyway, so
    // asking again just looks like a dead button.
    expect(shouldPrompt("denied", false)).toBe(false);
  });

  it("asks once when the browser has never been asked", () => {
    expect(shouldPrompt("prompt", false)).toBe(true);
  });

  it("falls back to our own record where the Permissions API is missing", () => {
    expect(shouldPrompt("unknown", false)).toBe(true);
    expect(shouldPrompt("unknown", true)).toBe(false);
  });
});
