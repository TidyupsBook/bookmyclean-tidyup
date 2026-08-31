// @vitest-environment jsdom
/**
 * The phone's one-time location ask. The rule is the same as the dashboard's:
 * put the question once, remember the answer whichever way it went, and never
 * ask again on that phone for that person.
 *
 * The decision itself is a pure function, tested directly — the component test
 * only pins the happy path, because react-native-web's Modal never unmounts
 * and "not visible" cannot be asserted by absence.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { shouldOfferLocationAtSignIn } from "@/lib/this-device";

const h = vi.hoisted(() => ({
  auth: { isSignedIn: true, userId: "user_boss" } as {
    isSignedIn: boolean;
    userId: string | null;
  },
  tracking: {
    status: "off" as string,
    enabled: false,
    permissionGranted: false,
    canAskAgain: true,
    enable: vi.fn(async () => {}),
  },
  store: new Map<string, string>(),
}));

vi.mock("@clerk/expo", () => ({ useAuth: () => h.auth }));

vi.mock("@expo/vector-icons", () => ({ Feather: () => null }));

vi.mock("@/lib/location-tracking", () => ({
  useLocationTracking: () => h.tracking,
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => h.store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      h.store.set(k, v);
    },
    removeItem: async (k: string) => {
      h.store.delete(k);
    },
  },
}));

import { LocationPermissionAsk } from "@/components/LocationPermissionAsk";
import { locationAskedStorageKey } from "@/lib/this-device";

beforeEach(() => {
  h.auth = { isSignedIn: true, userId: "user_boss" };
  h.tracking.enabled = false;
  h.tracking.permissionGranted = false;
  h.tracking.canAskAgain = true;
  h.tracking.enable.mockClear();
  h.store.clear();
});

afterEach(() => cleanup());

describe("when to ask", () => {
  const base = {
    supported: true,
    signedIn: true,
    enabled: false,
    permissionGranted: false,
    canAskAgain: true,
    askedBefore: false as boolean | null,
  };

  it("asks a phone that has never been asked", () => {
    expect(shouldOfferLocationAtSignIn(base)).toBe(true);
  });

  it("asks even when the OS permission is already granted", () => {
    expect(
      shouldOfferLocationAtSignIn({ ...base, permissionGranted: true }),
    ).toBe(true);
  });

  it("never asks twice", () => {
    expect(shouldOfferLocationAtSignIn({ ...base, askedBefore: true })).toBe(
      false,
    );
  });

  it("holds off until storage has answered", () => {
    // null means "we don't know yet" — asking on a hunch is how you ask twice.
    expect(shouldOfferLocationAtSignIn({ ...base, askedBefore: null })).toBe(
      false,
    );
  });

  it("does not ask when sharing is already on", () => {
    expect(shouldOfferLocationAtSignIn({ ...base, enabled: true })).toBe(false);
  });

  it("does not ask when the OS has locked us out for good", () => {
    // No permission and no further prompts allowed: the button would do
    // nothing visible. The Location tab offers Open Settings instead.
    expect(shouldOfferLocationAtSignIn({ ...base, canAskAgain: false })).toBe(
      false,
    );
  });

  it("never asks on web, which cannot report a position", () => {
    expect(shouldOfferLocationAtSignIn({ ...base, supported: false })).toBe(
      false,
    );
  });

  it("never asks someone who is not signed in", () => {
    expect(shouldOfferLocationAtSignIn({ ...base, signedIn: false })).toBe(
      false,
    );
  });
});

describe("the sheet", () => {
  it("turns tracking on and remembers that it asked", async () => {
    render(<LocationPermissionAsk />);
    const button = await screen.findByText("Turn it on");
    fireEvent.click(button);
    await waitFor(() => expect(h.tracking.enable).toHaveBeenCalled());
    expect(h.store.get(locationAskedStorageKey("user_boss"))).toBe("1");
  });

  it("remembers a refusal without starting tracking", async () => {
    render(<LocationPermissionAsk />);
    const button = await screen.findByText("Not now");
    fireEvent.click(button);
    await waitFor(() =>
      expect(h.store.get(locationAskedStorageKey("user_boss"))).toBe("1"),
    );
    expect(h.tracking.enable).not.toHaveBeenCalled();
  });

  it("does not carry one person's answer over to the next on the same phone", async () => {
    const { rerender } = render(<LocationPermissionAsk />);
    fireEvent.click(await screen.findByText("Not now"));
    await waitFor(() =>
      expect(h.store.get(locationAskedStorageKey("user_boss"))).toBe("1"),
    );

    // The phone changes hands without a reload.
    h.auth = { isSignedIn: true, userId: "user_cleaner" };
    rerender(<LocationPermissionAsk />);

    fireEvent.click(await screen.findByText("Turn it on"));
    await waitFor(() =>
      expect(h.store.get(locationAskedStorageKey("user_cleaner"))).toBe("1"),
    );
    expect(h.tracking.enable).toHaveBeenCalled();
  });

  it("keys the memory to the person, so a shared phone asks the next cleaner", async () => {
    h.store.set(locationAskedStorageKey("user_boss"), "1");
    h.auth = { isSignedIn: true, userId: "user_cleaner" };
    render(<LocationPermissionAsk />);
    // The previous person's answer must not silence the question for this one.
    const button = await screen.findByText("Turn it on");
    fireEvent.click(button);
    await waitFor(() => expect(h.tracking.enable).toHaveBeenCalled());
  });
});
