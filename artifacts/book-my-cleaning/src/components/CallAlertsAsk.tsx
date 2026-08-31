import { useEffect, useRef, useState } from "react";
import { BellRing, X } from "lucide-react";
import { useGetCurrentUser } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  askToNotify,
  notifyPermission,
  type NotifyPermission,
} from "@/lib/desktopNotify";
import {
  LOCATION_ASK_OVER_EVENT,
  hasThisDeviceBeenAsked,
  useThisDevice,
} from "@/components/DeviceLocationReporter";
import { shouldOfferLocationAtSignIn } from "@/lib/thisDevice";

/**
 * The one-time "should this computer pop up when the phone rings?" ask.
 *
 * The desktop pop-up is the only alert that reaches someone in another
 * window, and browsers only grant it from a click — so somebody has to ask.
 * Before this, the ask lived only on the booking desk, a page the owner has
 * no reason to sit on; in practice permission was never granted and the
 * pop-ups never fired.
 *
 * Shown only to whoever may take live calls, only while the browser has
 * never been asked, and never again on this device once answered or
 * dismissed — the same "costs one click, remembered forever" contract as the
 * crew-map ask.
 */
const ASKED_KEY = "bmc-call-alerts-asked";

function askedBefore(): boolean {
  try {
    return localStorage.getItem(ASKED_KEY) === "yes";
  } catch {
    return true; // storage unavailable — never nag on every load
  }
}

function markAsked(): void {
  try {
    localStorage.setItem(ASKED_KEY, "yes");
  } catch {
    // Private mode dropping the write just means one more ask next visit.
  }
}

/** The rule, separated so a test can pin it without a browser Notification. */
export function shouldOfferCallAlerts(args: {
  watching: boolean;
  permission: NotifyPermission;
  askedBefore: boolean;
  /**
   * The crew-map location dialog is (or is about to be) on screen. Two
   * permission questions on the same first sign-in fight each other — and
   * the loser is whichever one gets dismissed unread, forever. This card
   * waits its turn.
   */
  locationAskPending: boolean;
}): boolean {
  return (
    args.watching &&
    args.permission === "default" &&
    !args.askedBefore &&
    !args.locationAskPending
  );
}

export function CallAlertsAsk() {
  const { data: me } = useGetCurrentUser();
  const [answered, setAnswered] = useState(false);
  const [busy, setBusy] = useState(false);

  // The location dialog closing leaves no store change to re-render on (a
  // "no" only touches localStorage), so it announces itself with an event
  // and this re-checks.
  const [locationAskOver, setLocationAskOver] = useState(false);
  useEffect(() => {
    const over = () => setLocationAskOver(true);
    window.addEventListener(LOCATION_ASK_OVER_EVENT, over);
    return () => window.removeEventListener(LOCATION_ASK_OVER_EVENT, over);
  }, []);

  const device = useThisDevice();
  const locationAskEligibleNow =
    // Until the device store knows who this is, the location dialog may
    // still be about to appear — hold back rather than risk the collision.
    !device.ready ||
    shouldOfferLocationAtSignIn({
      ready: device.ready,
      sharing: device.sharing,
      permission: device.permission,
      askedBefore: hasThisDeviceBeenAsked(),
    });

  /**
   * Sticky on purpose: "Turn it on" in the location dialog records the ask
   * (making it look ineligible) while the dialog is still open and busy with
   * the browser's geolocation prompt. Once this card has seen the dialog
   * pending in this session, only the dialog's own closing announcement
   * frees the screen — a storage flag flipping mid-flight does not.
   */
  const sawLocationAsk = useRef(false);
  if (locationAskEligibleNow) sawLocationAsk.current = true;
  const locationAskPending =
    locationAskEligibleNow || (sawLocationAsk.current && !locationAskOver);

  const open =
    !answered &&
    shouldOfferCallAlerts({
      watching: me?.canTakeLiveCalls === true,
      permission: notifyPermission(),
      askedBefore: askedBefore(),
      locationAskPending,
    });

  if (!open) return null;

  function close(): void {
    markAsked();
    setAnswered(true);
  }

  return (
    <div
      className="fixed bottom-4 left-4 z-[60] max-w-xs rounded-xl border border-border bg-card shadow-lg p-4"
      data-testid="card-call-alerts-ask"
    >
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-brand-pink/10 text-brand-pink flex items-center justify-center shrink-0">
          <BellRing className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">
            Hear the phone from anywhere
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Let this computer pop up and ring when a call comes in — even while
            you're in another window.
          </p>
          <div className="flex items-center gap-2 mt-3">
            <Button
              size="sm"
              disabled={busy}
              data-testid="button-call-alerts-on"
              onClick={() => {
                setBusy(true);
                // The browser's own prompt takes it from here; whatever the
                // answer, this card has done its one job.
                void askToNotify().finally(close);
              }}
            >
              Turn on
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="button-call-alerts-later"
              onClick={close}
            >
              Not now
            </Button>
          </div>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          className="text-muted-foreground hover:text-foreground shrink-0"
          onClick={close}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
