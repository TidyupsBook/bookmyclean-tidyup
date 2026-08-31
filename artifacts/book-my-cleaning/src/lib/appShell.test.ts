import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";

import { markAppReady, reportStartupFailure } from "./appShell";

/**
 * The handoff from the static marketing shell to the React app, exercised
 * against the real `index.html` — inline bootstrap script, stylesheet and all.
 *
 * The bug these guard against: the shell used to be hidden on a timer shortly
 * after `DOMContentLoaded`, so anything that stopped React from painting (a
 * slow auth handshake, a module that threw on import) left the visitor looking
 * at a genuinely empty page. The rule now is that the page always has content
 * on it — the shell only goes when something has replaced it.
 */

const indexHtml = readFileSync(
  fileURLToPath(new URL("../../index.html", import.meta.url)),
  "utf8",
);

let open: JSDOM[] = [];

afterEach(() => {
  for (const dom of open) dom.window.close();
  open = [];
});

function loadPage() {
  const dom = new JSDOM(indexHtml, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://bookmycleaning.test/",
  });
  open.push(dom);

  const window = dom.window;
  const doc = window.document as unknown as Document;

  return {
    window,
    doc,
    /** How the browser would actually render the marketing shell. */
    shellDisplay: () =>
      window.getComputedStyle(window.document.getElementById("static-shell")!)
        .display,
    bannerText: () =>
      window.document.getElementById("startup-error")?.textContent ?? null,
    /** Stand in for React committing its first content into #root. */
    renderApp: () => {
      const painted = window.document.createElement("main");
      painted.textContent = "Dashboard";
      window.document.getElementById("root")!.appendChild(painted);
    },
    /** Let every pending timer and animation frame run. */
    settle: () => new Promise((resolve) => setTimeout(resolve, 100)),
  };
}

describe("static shell handoff", () => {
  it("serves the full marketing shell before any JS runs", () => {
    const page = loadPage();

    expect(page.shellDisplay()).toBe("block");
    expect(
      page.window.document.getElementById("static-shell")!.textContent,
    ).toContain("Sparkling spaces");
    expect(page.window.document.getElementById("root")!.childElementCount).toBe(
      0,
    );
  });

  it("keeps the shell up while the app has rendered nothing", async () => {
    const page = loadPage();

    // Nothing but the passage of time — which is exactly what used to dismiss
    // the shell and leave the page blank.
    await page.settle();

    expect(page.shellDisplay()).toBe("block");
    expect(markAppReady(page.doc)).toBe(false);
    expect(page.shellDisplay()).toBe("block");
  });

  it("dismisses the shell once the app has rendered content", () => {
    const page = loadPage();

    page.renderApp();

    expect(markAppReady(page.doc)).toBe(true);
    expect(page.shellDisplay()).toBe("none");
  });
});

describe("startup failures", () => {
  it("leaves readable content and an explanation when the app cannot start", () => {
    const page = loadPage();

    reportStartupFailure("Missing publishable key", page.doc);

    // The marketing page is still on screen, with the failure spelled out.
    expect(page.shellDisplay()).toBe("block");
    expect(page.bannerText()).toContain("The booking app didn't load.");
    expect(page.bannerText()).toContain("Missing publishable key");
    expect(page.bannerText()).toContain("(780) 718-5092");
    expect(
      page.window.document
        .getElementById("startup-error")!
        .getAttribute("role"),
    ).toBe("alert");
  });

  it("reports an error thrown while the app is booting", () => {
    const page = loadPage();

    page.window.dispatchEvent(
      new page.window.ErrorEvent("error", { message: "boom during import" }),
    );

    expect(page.bannerText()).toContain("boom during import");
    expect(page.shellDisplay()).toBe("block");
  });

  it("reports a bundle that never downloads", () => {
    const page = loadPage();

    const script = page.window.document.createElement("script");
    script.src = "/assets/index-deadbeef.js";
    page.window.document.head.appendChild(script);
    script.dispatchEvent(new page.window.Event("error"));

    expect(page.bannerText()).toContain("Part of the app failed to download");
  });

  it("ignores a blocked font stylesheet — the app still works without it", () => {
    const page = loadPage();

    const link = page.window.document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Nope";
    page.window.document.head.appendChild(link);
    link.dispatchEvent(new page.window.Event("error"));

    expect(page.bannerText()).toBeNull();
  });

  it("does not cover a running app with a late error banner", () => {
    const page = loadPage();

    page.renderApp();
    markAppReady(page.doc);
    page.window.dispatchEvent(
      new page.window.ErrorEvent("error", { message: "later, in the app" }),
    );

    expect(page.bannerText()).toBeNull();
    expect(page.shellDisplay()).toBe("none");
  });

  it("clears an earlier failure banner if the app does come up", () => {
    const page = loadPage();

    reportStartupFailure("slow start", page.doc);
    page.renderApp();
    markAppReady(page.doc);

    expect(page.bannerText()).toBeNull();
    expect(page.shellDisplay()).toBe("none");
  });
});
