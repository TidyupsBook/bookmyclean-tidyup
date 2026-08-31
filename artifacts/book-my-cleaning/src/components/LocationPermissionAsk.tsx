/**
 * The one-time "should this device show on the map?" ask.
 *
 * Before this existed, sharing was something you had to go looking for: a
 * switch on the Tracking page that nobody found unless they were told. The
 * owner signs in from a PC, an Android, an iPad and an iPhone and expects each
 * of them to offer to join the map the first time he uses it — and expects the
 * same of anyone who joins the company, exactly once.
 *
 * So this asks on the first signed-in page load of a device, and then never
 * again on that device, whatever the answer was. Refusing costs one click and
 * is remembered; the Tracking page switch is still there for anyone who
 * changes their mind later.
 */
import { useState } from "react";
import { MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  announceLocationAskOver,
  hasThisDeviceBeenAsked,
  markThisDeviceAsked,
  setThisDeviceSharing,
  useThisDevice,
} from "@/components/DeviceLocationReporter";
import { shouldOfferLocationAtSignIn } from "@/lib/thisDevice";

export function LocationPermissionAsk() {
  // Identity comes from the device store rather than a second /me call: the
  // reporter has already resolved who is signed in, and `ready` is precisely
  // "we know whose device this is".
  const device = useThisDevice();
  // Answered in this session: keeps the dialog shut for the rest of the visit
  // without depending on a storage read that a private-mode browser may drop.
  const [answered, setAnswered] = useState(false);
  const [busy, setBusy] = useState(false);

  const open =
    !answered &&
    shouldOfferLocationAtSignIn({
      ready: device.ready,
      sharing: device.sharing,
      permission: device.permission,
      // Only safe to read once the device has an identity; `ready` guarantees
      // that, and shouldOfferLocationAtSignIn checks it first.
      askedBefore: device.ready ? hasThisDeviceBeenAsked() : true,
    });

  // Closing the dialog any other way (Escape, the X, clicking outside) counts
  // as "not now" — it must not come back on the next page load.
  function close(): void {
    markThisDeviceAsked();
    setAnswered(true);
    // The screen is free again — the call-alerts card may take its turn.
    announceLocationAskOver();
  }

  async function turnOn(): Promise<void> {
    setBusy(true);
    // Recorded before the browser dialog, so a dismissed prompt still counts
    // as having been asked.
    markThisDeviceAsked();
    try {
      await setThisDeviceSharing(true);
    } finally {
      setBusy(false);
      setAnswered(true);
      // Announced only now, after the geolocation prompt settled and the
      // dialog closes — "asked" was recorded minutes of UI ago, but the
      // screen is only free at this point.
      announceLocationAskOver();
    }
  }

  const deviceName = device.label || "This device";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-primary/10">
            <MapPin className="size-5 text-primary" aria-hidden="true" />
          </div>
          <DialogTitle>Show {deviceName} on the crew map?</DialogTitle>
          <DialogDescription>
            Turning this on puts a live pin on the map while you&rsquo;re
            working, so the office can see who is nearest a job. We&rsquo;ll
            only ask once — you can change it any time from the Tracking page.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={close} disabled={busy}>
            Not now
          </Button>
          <Button onClick={() => void turnOn()} disabled={busy}>
            {busy ? "Turning on…" : "Turn it on"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
