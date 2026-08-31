/**
 * The dashboard reporting itself as a device.
 *
 * The office PC is a device like any phone: once the owner turns sharing on
 * for this browser, it registers itself (keeping the same key across
 * sessions, so it stays the *same* pin) and posts its position on the same
 * cadence the handsets use. That is what makes "Boss PC" a yellow marker on
 * the map beside the boss's iPhone rather than a gap.
 *
 * The permission rule is the delicate part, and it lives here: the browser is
 * asked at most **once**, and only because the user flipped the switch. An
 * already-granted browser is never prompted, an already-denied one is never
 * prompted again — it gets instructions instead, because a second prompt in a
 * browser that has said no simply never appears and looks like a broken
 * button.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  useGetCurrentUser,
  useReportStaffLocation,
} from "@workspace/api-client-react";
import {
  loadDeviceKey,
  defaultDeviceName,
  detectPlatform,
  deviceRecoveryKey,
  deviceLabelStorageKey,
  deviceSharingStorageKey,
  devicePromptedStorageKey,
  readStored,
  writeStored,
  readGeoPermission,
  shouldPrompt,
  GEO_DENIED_HELP,
  type GeoPermission,
  type DevicePlatform,
} from "@/lib/thisDevice";

/** Same 30 seconds the phones report on, so one crew moves at one speed. */
export const DEVICE_REPORT_MS = 30_000;

export type ThisDeviceState = {
  /** False until the signed-in user is known and storage has been read. */
  ready: boolean;
  deviceKey: string;
  /**
   * The server's id for this browser, known once it has reported at least
   * once. Renaming goes through the API by id, so a name given here survives
   * — and matches the one the owner sees for this machine on any other
   * screen. Null before the first report: there is no row to rename yet.
   */
  deviceId: number | null;
  label: string;
  platform: DevicePlatform;
  sharing: boolean;
  permission: GeoPermission;
  /** Rendered under the switch: a denial, or a server refusal. */
  notice: string | null;
  lastReportedAt: number | null;
};

const EMPTY: ThisDeviceState = {
  ready: false,
  deviceKey: "",
  deviceId: null,
  label: "",
  platform: "web",
  sharing: false,
  permission: "unknown",
  notice: null,
  lastReportedAt: null,
};

// A module-level store rather than context: the reporter is mounted once in
// the app shell while the switch lives on the Tracking page, and those two
// are nowhere near each other in the tree.
let state: ThisDeviceState = EMPTY;
let who = "";
const listeners = new Set<() => void>();

function emit(patch: Partial<ThisDeviceState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Adopt (or mint) this browser's identity for the signed-in user. Safe to
 * call repeatedly; it only does work when the user actually changes, so two
 * people sharing a machine never inherit each other's device.
 */
export function initThisDevice(user: string, isOwner: boolean): void {
  if (state.ready && who === user) return;
  who = user;
  const platform = detectPlatform(navigator.userAgent);
  const stored = readStored(deviceLabelStorageKey(user));
  emit({
    ready: true,
    deviceKey: loadDeviceKey(user),
    label:
      stored?.trim() ||
      defaultDeviceName({ isOwner, userAgent: navigator.userAgent }),
    platform,
    sharing: readStored(deviceSharingStorageKey(user)) === "on",
    notice: null,
  });
  void readGeoPermission().then((permission) => {
    // Someone else may have signed in while this read was in flight. Their
    // device state is not ours to overwrite — on a shared machine that would
    // hand them the previous person's permission and sharing flags.
    if (who !== user) return;
    // A browser that revoked permission between sessions must not be left
    // thinking it is still transmitting.
    if (permission === "denied") {
      emit({ permission, sharing: false, notice: GEO_DENIED_HELP });
      writeStored(deviceSharingStorageKey(user), "off");
      return;
    }
    emit({ permission });
  });
}

/**
 * Has this person already been asked, on this browser, whether to share?
 *
 * Only meaningful once `initThisDevice` has run — before that `who` is empty
 * and the answer would belong to nobody. Callers gate on `ready` first.
 */
export function hasThisDeviceBeenAsked(): boolean {
  return readStored(devicePromptedStorageKey(who)) === "1";
}

/**
 * Anyone waiting for the location ask to be over listens for this — the
 * call-alerts card holds back so two permission questions never fight for
 * the same first sign-in.
 *
 * Deliberately NOT fired from `markThisDeviceAsked`: "Turn it on" records
 * the ask before the browser's own geolocation prompt settles, while the
 * dialog is still on screen and busy. "Asked" is a storage fact; "the
 * dialog is gone" is what the queue actually waits for, and only the
 * dialog knows when that is.
 */
export const LOCATION_ASK_OVER_EVENT = "bmc-location-ask-over";

/** Tell whoever queued behind the location dialog that it has closed. */
export function announceLocationAskOver(): void {
  try {
    window.dispatchEvent(new Event(LOCATION_ASK_OVER_EVENT));
  } catch {
    // No window (tests, SSR) just means nobody is waiting.
  }
}

/**
 * Record that the question has been put to them. Written whichever way they
 * answer — including closing the ask without choosing — because "asked once"
 * means once, not "once per yes".
 */
export function markThisDeviceAsked(): void {
  writeStored(devicePromptedStorageKey(who), "1");
}

/** Rename this device. The new name rides along with the next report. */
export function setThisDeviceLabel(label: string): void {
  const trimmed = label.trim().slice(0, 60);
  if (!trimmed) return;
  writeStored(deviceLabelStorageKey(who), trimmed);
  emit({ label: trimmed });
}

/** The single permission prompt, wrapped as a promise. */
function askForLocationOnce(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      () => resolve(true),
      () => resolve(false),
      { enableHighAccuracy: false, timeout: 20_000, maximumAge: 60_000 },
    );
  });
}

/**
 * Turn this browser's own reporting on or off.
 *
 * Off is immediate and local. On is where the permission rule applies: check
 * what the browser has already decided, prompt only if it has never decided,
 * and on a refusal show guidance rather than trying again.
 */
export async function setThisDeviceSharing(next: boolean): Promise<void> {
  if (!next) {
    writeStored(deviceSharingStorageKey(who), "off");
    emit({ sharing: false, notice: null });
    return;
  }
  if (!navigator.geolocation) {
    emit({
      sharing: false,
      notice: "This browser can't report a location.",
    });
    return;
  }

  const permission = await readGeoPermission();
  if (permission === "denied") {
    emit({ sharing: false, permission, notice: GEO_DENIED_HELP });
    return;
  }

  const askedBefore = readStored(devicePromptedStorageKey(who)) === "1";
  if (shouldPrompt(permission, askedBefore)) {
    // Recorded BEFORE the dialog: a user who dismisses it without choosing
    // has still been asked, and asking again on the next click is the nagging
    // the requirement rules out.
    writeStored(devicePromptedStorageKey(who), "1");
    const granted = await askForLocationOnce();
    if (!granted) {
      emit({ sharing: false, permission: "denied", notice: GEO_DENIED_HELP });
      return;
    }
  }

  writeStored(deviceSharingStorageKey(who), "on");
  emit({ sharing: true, permission: "granted", notice: null });
}

/** Read "this device" from anywhere in the app. */
export function useThisDevice(): ThisDeviceState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => EMPTY,
  );
}

/**
 * Mounted once in the app shell so the dashboard keeps reporting as the user
 * moves around the app, instead of only while the Tracking page is open.
 * Renders nothing.
 */
export function DeviceLocationReporter() {
  const { data: me } = useGetCurrentUser();
  const device = useThisDevice();
  const report = useReportStaffLocation();

  const reportRef = useRef(report.mutateAsync);
  reportRef.current = report.mutateAsync;

  const identity = me?.email ?? "";
  const isOwner = me?.role === "owner";
  useEffect(() => {
    if (!identity) return;
    initThisDevice(identity, isOwner);
  }, [identity, isOwner]);

  const { ready, sharing, permission, deviceKey, label, platform } = device;

  useEffect(() => {
    if (!ready || !sharing || permission === "denied") return;
    if (!navigator.geolocation) return;
    let cancelled = false;

    const tick = () => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (cancelled) return;
          void reportRef
            .current({
              data: {
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                accuracy: pos.coords.accuracy ?? null,
                deviceKey,
                recoveryKey: deviceRecoveryKey(),
                deviceLabel: label,
                platform,
              },
            })
            .then((result) => {
              if (cancelled) return;
              emit({
                lastReportedAt: Date.now(),
                notice: result.recoveryMatched
                  ? "This device was recovered after its storage was reset. Sharing is back on; sending its first fresh location now."
                  : null,
                deviceId: result.deviceId ?? null,
                // The name of record is the server's: another screen may have
                // renamed this machine since the last tick.
                ...(result.deviceLabel ? { label: result.deviceLabel } : {}),
              });
              if (result.deviceLabel) {
                writeStored(deviceLabelStorageKey(who), result.deviceLabel);
              }
            })
            .catch(() => {
              // A dropped request is the next tick's problem; the map already
              // dims a car that stops reporting.
            });
        },
        (err) => {
          if (cancelled) return;
          if (err.code === err.PERMISSION_DENIED) {
            writeStored(deviceSharingStorageKey(who), "off");
            emit({
              sharing: false,
              permission: "denied",
              notice: GEO_DENIED_HELP,
            });
            void reportRef
              .current({
                data: {
                  lat: null,
                  lng: null,
                  accuracy: null,
                  deviceKey,
                  recoveryKey: deviceRecoveryKey(),
                  deviceLabel: label,
                  platform,
                  locationHealth: "permission-denied",
                },
              })
              .catch(() => {});
          }
        },
        { enableHighAccuracy: true, timeout: 20_000, maximumAge: 15_000 },
      );
    };

    tick();
    const timer = window.setInterval(tick, DEVICE_REPORT_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [ready, sharing, permission, deviceKey, label, platform]);

  return null;
}
