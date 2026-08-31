// @vitest-environment jsdom
/**
 * The repeating phone ring: it keeps ringing on a cadence, falls silent on
 * any click or keypress (someone heard it), stops when told (the call
 * ended), and gives up on its own after ringing its fill — so a missed call
 * can never leave a tab ringing forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRinging, startRinging, stopRinging } from "./chime";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  stopRinging();
  vi.useRealTimers();
});

describe("startRinging", () => {
  it("rings until stopped", () => {
    startRinging();
    expect(isRinging()).toBe(true);
    vi.advanceTimersByTime(6_000);
    expect(isRinging()).toBe(true);
    stopRinging();
    expect(isRinging()).toBe(false);
  });

  it("any click means it was heard", () => {
    startRinging();
    window.dispatchEvent(new Event("pointerdown"));
    expect(isRinging()).toBe(false);
  });

  it("any keypress means it was heard", () => {
    startRinging();
    window.dispatchEvent(new Event("keydown"));
    expect(isRinging()).toBe(false);
  });

  it("gives up on its own after ringing its fill", () => {
    startRinging();
    vi.advanceTimersByTime(60_000);
    expect(isRinging()).toBe(false);
  });

  it("a second start while ringing does not double up", () => {
    startRinging();
    startRinging();
    stopRinging();
    expect(isRinging()).toBe(false);
  });
});
