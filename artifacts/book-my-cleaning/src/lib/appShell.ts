/**
 * The handoff between the static marketing shell in `index.html` and the React
 * app.
 *
 * `index.html` ships a complete marketing page (`#static-shell`) so crawlers
 * and JS-disabled visitors get real content. That shell used to be hidden on a
 * timer — two animation frames after `DOMContentLoaded` — which meant a slow
 * or broken React boot left a genuinely blank page behind it. Now the shell is
 * dismissed only on evidence that React put something in `#root`, and a boot
 * that never gets that far replaces the silence with a readable message.
 *
 * The failure banner itself is built by the inline bootstrap script in
 * `index.html`, because it has to work when this bundle never runs at all (a
 * chunk that 404s, a module that throws while loading). This module is the
 * typed wrapper the app calls into, with a plain-text fallback for the case
 * where the bootstrap script is missing.
 */

/** Class on `<body>` that hides `#static-shell`. Mirrors the rule in index.html. */
export const APP_READY_CLASS = "app-ready";

/** Contract exposed by the inline bootstrap script in index.html. */
export interface ShellBridge {
  /** The app painted: drop the static shell and ignore any later boot errors. */
  ready(): void;
  /** The app could not start: show `message` without removing the shell. */
  fail(message: string): void;
}

declare global {
  interface Window {
    __bmcShell?: ShellBridge;
  }
}

function shellBridge(doc: Document): ShellBridge | undefined {
  return doc.defaultView?.__bmcShell;
}

/**
 * Hand the page over from the static shell to React.
 *
 * Returns `false` — and leaves the shell up — when `#root` is still empty, so
 * "React mounted" is never assumed on anything but rendered content. Call this
 * from a layout effect: the DOM is committed but the browser has not painted,
 * so the swap happens in one frame with no flash and no doubled content.
 */
export function markAppReady(doc: Document = document): boolean {
  const root = doc.getElementById("root");
  if (!root || root.childElementCount === 0) return false;

  const bridge = shellBridge(doc);
  if (bridge) {
    bridge.ready();
  } else {
    doc.body.classList.add(APP_READY_CLASS);
  }
  return true;
}

/**
 * Say out loud that the app failed to start. The static shell stays on screen —
 * a marketing page plus an explanation beats an empty document.
 */
export function reportStartupFailure(
  message: string,
  doc: Document = document,
): void {
  const bridge = shellBridge(doc);
  if (bridge) {
    bridge.fail(message);
    return;
  }

  // Bootstrap script missing (it should never be): plain text is still better
  // than nothing.
  const fallback = doc.createElement("div");
  fallback.id = "startup-error";
  fallback.setAttribute("role", "alert");
  fallback.textContent = message;
  doc.body.insertBefore(fallback, doc.body.firstChild);
}

/** Best readable one-liner for whatever was thrown. */
export function describeStartupError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Something went wrong while starting the app.";
}
