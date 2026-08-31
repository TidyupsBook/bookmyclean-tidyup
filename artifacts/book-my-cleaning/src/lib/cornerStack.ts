import { useLocation } from "wouter";
import { useGetCurrentUser } from "@workspace/api-client-react";
import { useCallCapture, type CallCapture } from "@/lib/callCapture";

/**
 * Traffic control for the bottom-right corner.
 *
 * Three floating pieces want that spot: the standing live-call bar (the
 * microphone is running, or needs a tap), the Live booking launcher, and the
 * back-to-top button. Piled on top of each other they cover one another's
 * buttons at exactly the moment they matter, so ownership is decided here,
 * once, and every corner piece reads the same answer:
 *
 *   1. The live-call bar, when it has real work to show — a capture session
 *      in progress, a one-tap permission ask, or a decline worth acting on.
 *      It carries its own "Take booking" button, so the launcher would be a
 *      duplicate underneath it.
 *   2. Otherwise the Live booking launcher, for anyone entitled to take
 *      live calls.
 *   3. The back-to-top button never owns the corner; it queues *above* the
 *      launcher when both are on screen, and steps aside entirely while the
 *      bar is up.
 *
 * The booking desk gets none of them — it already shows the full call panel.
 */
export type CornerOwner = "live-call-bar" | "live-booking-launcher" | null;

/**
 * Does the live-call bar have something worth the corner?
 *
 * An `unsupported` decline deliberately does not count. On an iPad every
 * single ring would raise it (no browser there can listen), which would park
 * the bar over the launcher forever on exactly the device the launcher
 * exists for. The launcher's waiting state *is* the unsupported browser's
 * path — open the desk, form filled from Quo's write-up — and the desk's own
 * notice explains the missing microphone to anyone who goes looking.
 */
export function liveCallBarBusy(capture: CallCapture | null): boolean {
  if (!capture) return false;
  if (capture.transcript.active) return true;
  if (capture.needsPermission) return true;
  return capture.declined !== null && capture.declined !== "unsupported";
}

export function cornerOwner(opts: {
  canTakeLiveCalls: boolean;
  onBookingDesk: boolean;
  barBusy: boolean;
}): CornerOwner {
  if (!opts.canTakeLiveCalls || opts.onBookingDesk) return null;
  if (opts.barBusy) return "live-call-bar";
  return "live-booking-launcher";
}

/**
 * The corner's current owner, from live app state. The entitlement check is
 * the same server-computed flag every live-call surface keys on, so losing
 * access mid-session clears the whole corner in the same render pass.
 */
export function useCornerOwner(): CornerOwner {
  const [location] = useLocation();
  const { data: me } = useGetCurrentUser();
  const capture = useCallCapture();
  return cornerOwner({
    canTakeLiveCalls: me?.canTakeLiveCalls === true,
    onBookingDesk: location.startsWith("/bookings/new"),
    barBusy: liveCallBarBusy(capture),
  });
}
