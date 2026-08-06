/**
 * Sending someone off to another company's sign-in page (Jobber's, today).
 *
 * The dashboard is often viewed inside the workspace preview, which is an
 * iframe. Jobber — like most sign-in pages — refuses to be framed, so a plain
 * `location.href` there paints a white screen with nothing to click and no
 * error anywhere.
 *
 * Escaping the frame has one hard constraint: the tab must be allocated
 * synchronously inside the click handler. Waiting for the server to hand back
 * an authorize URL first spends the browser's user-activation window, and the
 * pop-up gets blocked in exactly the case this exists to fix. So the tab is
 * opened blank on click and pointed at Jobber once the URL arrives.
 */

/** True when this page is running inside someone else's frame. */
export function isFramed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    // A cross-origin parent throws on access, which is itself the answer.
    return true;
  }
}

export type AuthTab = {
  /** Whether a separate tab was needed at all. */
  readonly framed: boolean;
  /** The browser refused to allocate the tab; nothing will happen without help. */
  readonly blocked: boolean;
  /** Send the user to the provider. */
  navigate(url: string): void;
  /** The request failed — clean up the blank tab rather than stranding it. */
  cancel(): void;
};

const PLACEHOLDER = `<!doctype html><meta charset="utf-8"><title>Opening Jobber…</title><body style="margin:0;display:grid;place-items:center;height:100vh;font:16px system-ui;background:#0b0b12;color:#e8e8f0">Opening Jobber…</body>`;

/**
 * Allocate the destination for an external sign-in. Call this synchronously
 * from the click handler, then `navigate` once the authorize URL is known.
 */
export function openAuthTab(): AuthTab {
  if (!isFramed()) {
    return {
      framed: false,
      blocked: false,
      navigate(url) {
        window.location.href = url;
      },
      cancel() {},
    };
  }

  // Deliberately no `noopener` here: that feature returns a null handle, and
  // the handle is the whole point — it is what gets pointed at Jobber a moment
  // later. The opener is disowned by hand instead, which is the same
  // protection without giving up the reference.
  const tab = window.open("", "_blank");
  if (tab) {
    try {
      tab.opener = null;
    } catch {
      // Older browsers refuse the assignment; the destination is Jobber's own
      // sign-in page, so this is belt-and-braces rather than load-bearing.
    }
    try {
      tab.document.write(PLACEHOLDER);
      tab.document.close();
    } catch {
      // A blank tab is still a working tab.
    }
  }

  return {
    framed: true,
    blocked: !tab,
    navigate(url) {
      // `replace` keeps the placeholder out of the new tab's back history.
      tab?.location.replace(url);
    },
    cancel() {
      try {
        tab?.close();
      } catch {
        // Nothing more to do; an empty tab is harmless.
      }
    },
  };
}

/** True for the throwaway workspace preview host, which changes. */
export function isPreviewUrl(url: string | null | undefined): boolean {
  return (url ?? "").includes(".replit.dev");
}
