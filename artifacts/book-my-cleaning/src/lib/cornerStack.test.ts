/**
 * Who owns the bottom-right corner. These rules keep the live-call bar, the
 * Live booking launcher and the back-to-top button queuing instead of piling
 * on top of one another's buttons.
 */
import { describe, expect, it } from "vitest";
import type { CallCapture } from "@/lib/callCapture";
import { cornerOwner, liveCallBarBusy } from "./cornerStack";

function capture(over: {
  active?: boolean;
  needsPermission?: boolean;
  declined?: CallCapture["declined"];
}): CallCapture {
  return {
    transcript: { active: over.active ?? false },
    needsPermission: over.needsPermission ?? false,
    declined: over.declined ?? null,
  } as unknown as CallCapture;
}

describe("liveCallBarBusy", () => {
  it("is quiet with no capture session at all", () => {
    expect(liveCallBarBusy(null)).toBe(false);
    expect(liveCallBarBusy(capture({}))).toBe(false);
  });

  it("claims the corner while capturing or waiting on a permission tap", () => {
    expect(liveCallBarBusy(capture({ active: true }))).toBe(true);
    expect(liveCallBarBusy(capture({ needsPermission: true }))).toBe(true);
  });

  it("claims the corner for actionable declines", () => {
    expect(liveCallBarBusy(capture({ declined: "busy-other-call" }))).toBe(
      true,
    );
    expect(liveCallBarBusy(capture({ declined: "start-failed" }))).toBe(true);
  });

  it("ignores 'unsupported' — an iPad rings that on every call, and the launcher is that device's path", () => {
    expect(liveCallBarBusy(capture({ declined: "unsupported" }))).toBe(false);
  });
});

describe("cornerOwner", () => {
  it("gives nobody the corner without live-call access", () => {
    expect(
      cornerOwner({
        canTakeLiveCalls: false,
        onBookingDesk: false,
        barBusy: true,
      }),
    ).toBeNull();
  });

  it("gives nobody the corner on the booking desk itself", () => {
    expect(
      cornerOwner({
        canTakeLiveCalls: true,
        onBookingDesk: true,
        barBusy: false,
      }),
    ).toBeNull();
  });

  it("lets the live-call bar outrank the launcher", () => {
    expect(
      cornerOwner({
        canTakeLiveCalls: true,
        onBookingDesk: false,
        barBusy: true,
      }),
    ).toBe("live-call-bar");
  });

  it("hands the corner to the launcher otherwise", () => {
    expect(
      cornerOwner({
        canTakeLiveCalls: true,
        onBookingDesk: false,
        barBusy: false,
      }),
    ).toBe("live-booking-launcher");
  });
});
