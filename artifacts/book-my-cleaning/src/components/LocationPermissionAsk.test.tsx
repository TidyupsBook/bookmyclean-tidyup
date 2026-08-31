// @vitest-environment jsdom
/**
 * The sign-in location ask has exactly one job and one trap: it must appear
 * once for a device that has never been asked, and must never appear again
 * afterwards — including for someone who said no, closed it, or whose browser
 * has already refused location for the site. Getting that wrong turns the
 * dashboard into something that nags on every page load.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { shouldOfferLocationAtSignIn } from "@/lib/thisDevice";

const h = vi.hoisted(() => ({
  device: {
    ready: true,
    deviceKey: "k",
    deviceId: null as number | null,
    label: "Boss PC",
    platform: "web" as const,
    sharing: false,
    permission: "prompt" as "granted" | "denied" | "prompt" | "unknown",
    notice: null as string | null,
    lastReportedAt: null as number | null,
  },
  asked: false,
  markAsked: vi.fn(),
  setSharing: vi.fn(async () => {}),
  announceOver: vi.fn(),
}));

vi.mock("@/components/DeviceLocationReporter", () => ({
  useThisDevice: () => h.device,
  hasThisDeviceBeenAsked: () => h.asked,
  markThisDeviceAsked: h.markAsked,
  setThisDeviceSharing: h.setSharing,
  announceLocationAskOver: h.announceOver,
}));

import { LocationPermissionAsk } from "@/components/LocationPermissionAsk";

beforeEach(() => {
  h.device.ready = true;
  h.device.sharing = false;
  h.device.permission = "prompt";
  h.device.label = "Boss PC";
  h.asked = false;
  h.markAsked.mockClear();
  h.setSharing.mockClear();
  h.announceOver.mockClear();
});

afterEach(() => cleanup());

describe("when to ask at all", () => {
  const base = {
    ready: true,
    sharing: false,
    permission: "prompt" as const,
    askedBefore: false,
  };

  it("asks a device that has never been asked", () => {
    expect(shouldOfferLocationAtSignIn(base)).toBe(true);
  });

  it("asks even when the browser permission is already granted", () => {
    // Permission and sharing are different answers: a machine allowed to read
    // a position but with the switch off is a person missing from the map.
    expect(
      shouldOfferLocationAtSignIn({ ...base, permission: "granted" }),
    ).toBe(true);
  });

  it("never asks twice", () => {
    expect(shouldOfferLocationAtSignIn({ ...base, askedBefore: true })).toBe(
      false,
    );
  });

  it("never asks a browser that has refused", () => {
    expect(shouldOfferLocationAtSignIn({ ...base, permission: "denied" })).toBe(
      false,
    );
  });

  it("does not ask a device that is already sharing", () => {
    expect(shouldOfferLocationAtSignIn({ ...base, sharing: true })).toBe(false);
  });

  it("waits until the device identity is known", () => {
    // Asking before init would read the 'anon' record and ask the next person
    // signing in on this machine all over again.
    expect(shouldOfferLocationAtSignIn({ ...base, ready: false })).toBe(false);
  });
});

describe("the dialog", () => {
  it("names the device it is asking about", () => {
    render(<LocationPermissionAsk />);
    expect(
      screen.getByText(/Show Boss PC on the crew map\?/i),
    ).toBeInTheDocument();
  });

  it("turns sharing on and records the ask", async () => {
    render(<LocationPermissionAsk />);
    fireEvent.click(screen.getByRole("button", { name: /turn it on/i }));
    await waitFor(() => expect(h.setSharing).toHaveBeenCalledWith(true));
    expect(h.markAsked).toHaveBeenCalled();
  });

  it("announces the screen free only after the geolocation prompt settles", async () => {
    // The browser's own location prompt can sit open for a long time; the
    // dialog stays up ("Turning on…") the whole while. Whoever is queued
    // behind it must not be told the screen is free until it really is.
    let settle: () => void = () => {};
    h.setSharing.mockImplementationOnce(
      () => new Promise<void>((resolve) => (settle = resolve)),
    );
    render(<LocationPermissionAsk />);
    fireEvent.click(screen.getByRole("button", { name: /turn it on/i }));

    // Asked is recorded at once — but the dialog has not finished.
    await waitFor(() => expect(h.markAsked).toHaveBeenCalled());
    expect(h.announceOver).not.toHaveBeenCalled();

    settle();
    await waitFor(() => expect(h.announceOver).toHaveBeenCalled());
  });

  it("announces the screen free when the ask is declined", () => {
    render(<LocationPermissionAsk />);
    fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    expect(h.announceOver).toHaveBeenCalled();
  });

  it("remembers a refusal, so it never comes back", async () => {
    render(<LocationPermissionAsk />);
    fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    expect(h.markAsked).toHaveBeenCalled();
    expect(h.setSharing).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByText(/Show Boss PC/i)).not.toBeInTheDocument(),
    );
  });

  it("stays away once this device has been asked before", () => {
    h.asked = true;
    render(<LocationPermissionAsk />);
    expect(screen.queryByText(/crew map/i)).not.toBeInTheDocument();
  });

  it("stays away until the device identity is resolved", () => {
    h.device.ready = false;
    render(<LocationPermissionAsk />);
    expect(screen.queryByText(/crew map/i)).not.toBeInTheDocument();
  });
});
