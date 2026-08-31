/**
 * Desktop pop-ups for things that can't wait for someone to look at the tab.
 *
 * A toast inside the app is invisible to a dispatcher who is in their email,
 * and a ringing phone is exactly the moment that matters. This is the one
 * channel that reaches them there — but only with permission, only while the
 * tab is in the background (otherwise it duplicates the toast they can already
 * see), and never at the cost of an exception on a browser without it.
 */

export type NotifyPermission = "granted" | "denied" | "default" | "unsupported";

function api(): typeof Notification | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as unknown as { Notification?: typeof Notification })
    .Notification;
  return ctor ?? null;
}

export function notifyPermission(): NotifyPermission {
  const ctor = api();
  if (!ctor) return "unsupported";
  return ctor.permission as NotifyPermission;
}

/**
 * Must be called from a click. Browsers reject (and Chrome permanently
 * blocks) a permission prompt raised out of nowhere.
 */
export async function askToNotify(): Promise<NotifyPermission> {
  const ctor = api();
  if (!ctor) return "unsupported";
  if (ctor.permission !== "default") return ctor.permission as NotifyPermission;
  try {
    return (await ctor.requestPermission()) as NotifyPermission;
  } catch {
    return "denied";
  }
}

/**
 * Whether a pop-up is the right way to say this.
 *
 * Pulled out as a plain function because the rule is the interesting part:
 * looking at the app already means being told, so a pop-up then is just noise
 * on top of the toast.
 */
export function shouldPopUp(
  permission: NotifyPermission,
  documentHidden: boolean,
): boolean {
  return permission === "granted" && documentHidden;
}

/**
 * Show a pop-up if it's welcome. `tag` collapses repeats, so a call that is
 * still ringing on the next poll replaces its own notification instead of
 * stacking up a column of them.
 */
export function popUp(options: {
  title: string;
  body: string;
  tag: string;
  onClick?: () => void;
}): void {
  const ctor = api();
  if (!ctor) return;
  if (!shouldPopUp(notifyPermission(), document.hidden)) return;
  try {
    const notification = new ctor(options.title, {
      body: options.body,
      tag: options.tag,
      // The point is to be seen late — a pop-up that vanishes while the
      // dispatcher is in another window has done nothing.
      requireInteraction: true,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
      options.onClick?.();
    };
  } catch {
    // Some browsers only allow notifications from a service worker. Nothing
    // to do about that here, and it must not break the caller.
  }
}
