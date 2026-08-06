import { afterEach, describe, expect, it, vi } from "vitest";
import { isPreviewUrl, openAuthTab } from "./externalAuth";

/**
 * The behaviour worth pinning: inside a frame we must leave the frame, and the
 * tab has to be claimed on the click rather than after the server replies.
 * Jobber refuses to render in a frame, so getting this wrong is a white screen
 * with no error — exactly the failure this helper exists to prevent.
 */
function stubWindow(framed: boolean, open?: () => unknown) {
  const self = {};
  const win = {
    self,
    top: framed ? {} : self,
    location: { href: "" },
    open: open ?? (() => makeTab()),
  };
  vi.stubGlobal("window", win);
  return win;
}

function makeTab() {
  return {
    opener: {},
    closed: false,
    location: {
      href: "",
      replace(url: string) {
        this.href = url;
      },
    },
    document: { write: vi.fn(), close: vi.fn() },
    close() {
      this.closed = true;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openAuthTab", () => {
  it("navigates in place when the app owns the tab", () => {
    const win = stubWindow(false);
    const tab = openAuthTab();
    expect(tab.framed).toBe(false);
    expect(tab.blocked).toBe(false);
    tab.navigate("https://jobber.example/auth");
    expect(win.location.href).toBe("https://jobber.example/auth");
  });

  it("claims a blank tab up front and points it at the provider later", () => {
    const opened = makeTab();
    const open = vi.fn(() => opened);
    const win = stubWindow(true, open);

    const tab = openAuthTab();
    // Claimed during the click, before any authorize URL exists.
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(tab.blocked).toBe(false);
    // The opener is disowned by hand, since keeping the handle rules out the
    // browser's own noopener flag.
    expect(opened.opener).toBeNull();

    tab.navigate("https://jobber.example/auth");
    expect(opened.location.href).toBe("https://jobber.example/auth");
    // The frame itself must be left alone.
    expect(win.location.href).toBe("");
  });

  it("closes the blank tab when the connection never starts", () => {
    const opened = makeTab();
    stubWindow(true, () => opened);
    openAuthTab().cancel();
    expect(opened.closed).toBe(true);
  });

  it("reports a blocked pop-up instead of appearing to work", () => {
    stubWindow(true, () => null);
    expect(openAuthTab().blocked).toBe(true);
  });
});

describe("isPreviewUrl", () => {
  it("spots the throwaway workspace address", () => {
    expect(isPreviewUrl("https://abc-00-xyz.riker.replit.dev/api/x")).toBe(
      true,
    );
    expect(isPreviewUrl("https://bookmycleaning.net/api/x")).toBe(false);
    expect(isPreviewUrl(null)).toBe(false);
  });
});
