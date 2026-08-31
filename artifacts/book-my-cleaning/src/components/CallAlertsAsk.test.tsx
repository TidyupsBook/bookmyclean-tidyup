// @vitest-environment jsdom
/**
 * The one-time "should this computer pop up when the phone rings?" ask.
 *
 * Two rules matter enough to pin: it never appears while the crew-map
 * location dialog has first claim on the screen (two permission questions at
 * once means one gets dismissed unread, forever), and it takes its turn the
 * moment that dialog is answered — in the same session, without waiting for
 * the next page load.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("@workspace/api-client-react", () => ({
  useGetCurrentUser: () => ({
    data: { role: "owner", canTakeLiveCalls: watching },
  }),
}));

let watching = true;

// The device store drives whether the location dialog is (about to be) up.
let deviceState = {
  ready: true,
  sharing: false,
  permission: "granted" as string,
};
let deviceAsked = true;
vi.mock("@/components/DeviceLocationReporter", () => ({
  LOCATION_ASK_OVER_EVENT: "bmc-location-ask-over",
  useThisDevice: () => deviceState,
  hasThisDeviceBeenAsked: () => deviceAsked,
}));

let browserPermission = "default";
const askToNotify = vi.fn(async () => "granted" as const);
vi.mock("@/lib/desktopNotify", () => ({
  notifyPermission: () => browserPermission,
  askToNotify: () => askToNotify(),
}));

import {
  CallAlertsAsk,
  shouldOfferCallAlerts,
} from "@/components/CallAlertsAsk";
import type { NotifyPermission } from "@/lib/desktopNotify";

beforeEach(() => {
  localStorage.clear();
  watching = true;
  browserPermission = "default";
  deviceState = { ready: true, sharing: false, permission: "granted" };
  deviceAsked = true;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("shouldOfferCallAlerts", () => {
  const base = {
    watching: true,
    permission: "default" as NotifyPermission,
    askedBefore: false,
    locationAskPending: false,
  };

  it("offers exactly once, to call-takers, while the browser has never decided", () => {
    expect(shouldOfferCallAlerts(base)).toBe(true);
    expect(shouldOfferCallAlerts({ ...base, watching: false })).toBe(false);
    expect(shouldOfferCallAlerts({ ...base, permission: "granted" })).toBe(
      false,
    );
    expect(shouldOfferCallAlerts({ ...base, permission: "denied" })).toBe(
      false,
    );
    expect(shouldOfferCallAlerts({ ...base, askedBefore: true })).toBe(false);
  });

  it("waits its turn behind the location dialog", () => {
    expect(shouldOfferCallAlerts({ ...base, locationAskPending: true })).toBe(
      false,
    );
  });
});

describe("<CallAlertsAsk />", () => {
  it("shows when it alone wants the screen", () => {
    render(<CallAlertsAsk />);
    expect(screen.getByTestId("card-call-alerts-ask")).toBeTruthy();
  });

  it("stays hidden while the location dialog is up, then takes its turn when it closes", () => {
    // A brand-new device: the location ask is about to claim the screen.
    deviceAsked = false;
    render(<CallAlertsAsk />);
    expect(screen.queryByTestId("card-call-alerts-ask")).toBeNull();

    // The location dialog is answered (either way): it marks the device
    // asked and, once truly closed, announces itself.
    deviceAsked = true;
    act(() => {
      window.dispatchEvent(new Event("bmc-location-ask-over"));
    });
    expect(screen.getByTestId("card-call-alerts-ask")).toBeTruthy();
  });

  it("'Turn it on' marking the device asked mid-flight frees nothing until the dialog closes", () => {
    // The location dialog is up.
    deviceAsked = false;
    const view = render(<CallAlertsAsk />);
    expect(screen.queryByTestId("card-call-alerts-ask")).toBeNull();

    // "Turn it on" records the ask immediately — but the dialog is still on
    // screen, busy with the browser's own geolocation prompt. A re-render
    // (any store update) must not surface this card yet.
    deviceAsked = true;
    view.rerender(<CallAlertsAsk />);
    expect(screen.queryByTestId("card-call-alerts-ask")).toBeNull();

    // Only the dialog's own closing announcement frees the screen.
    act(() => {
      window.dispatchEvent(new Event("bmc-location-ask-over"));
    });
    expect(screen.getByTestId("card-call-alerts-ask")).toBeTruthy();
  });

  it("holds back until the device store even knows whose browser this is", () => {
    deviceState = { ...deviceState, ready: false };
    render(<CallAlertsAsk />);
    expect(screen.queryByTestId("card-call-alerts-ask")).toBeNull();
  });

  it("turn on asks the browser and never comes back", async () => {
    render(<CallAlertsAsk />);
    // The browser prompt is async; "asked" is only recorded once it settles.
    await act(async () => {
      screen.getByTestId("button-call-alerts-on").click();
      await Promise.resolve();
    });
    expect(askToNotify).toHaveBeenCalled();

    // Asked is asked, whatever the browser answered.
    cleanup();
    render(<CallAlertsAsk />);
    expect(screen.queryByTestId("card-call-alerts-ask")).toBeNull();
  });

  it("not now is remembered forever, not per page load", () => {
    render(<CallAlertsAsk />);
    act(() => {
      screen.getByTestId("button-call-alerts-later").click();
    });
    expect(screen.queryByTestId("card-call-alerts-ask")).toBeNull();

    cleanup();
    render(<CallAlertsAsk />);
    expect(screen.queryByTestId("card-call-alerts-ask")).toBeNull();
  });
});
