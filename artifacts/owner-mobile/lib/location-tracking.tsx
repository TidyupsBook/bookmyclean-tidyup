import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, Platform } from "react-native";
import { useAuth } from "@clerk/expo";
import { useReportStaffLocation } from "@workspace/api-client-react";
import * as Location from "expo-location";
import {
  defaultDeviceLabel,
  devicePlatform,
  deviceRecoveryKey,
  loadDeviceKey,
  hasLocationConsent,
  markLocationConsent,
} from "@/lib/this-device";

// How often we push a fresh position to the dispatcher's live map.
const SEND_INTERVAL_MS = 30_000;

/**
 * A cleaner's location-sharing status, in priority order of what to surface:
 * - "unsupported": platform can't provide GPS (web) — no watcher, honest label.
 * - "denied": OS permission refused — user must grant (or open Settings).
 * - "off": permission is fine but consent has not been granted.
 * - "sharing": actively watching + sending.
 *
 * There is deliberately no working-hours state: *who may watch, and when* is
 * decided by the server in the company's timezone, not by this phone's clock.
 */
export type TrackingStatus = "unsupported" | "denied" | "off" | "sharing";

interface LocationTrackingValue {
  status: TrackingStatus;
  /** User-facing toggle position (what they asked for), independent of gating. */
  enabled: boolean;
  /** Whether the OS foreground permission is currently granted. */
  permissionGranted: boolean;
  /** Whether the OS will still let us prompt (false → send them to Settings). */
  canAskAgain: boolean;
  /** Deprecated compatibility field; owner approval is no longer a gate. */
  blockedByOwner: false;
  /** ISO timestamp of the last 2xx send, or null if none yet this session. */
  lastSentAt: string | null;
  /** Turn sharing on: requests permission if needed, then starts the watcher. */
  enable: () => Promise<void>;
  /** Turn sharing off and tear the watcher down. */
  disable: () => void;
}

const LocationTrackingContext = createContext<LocationTrackingValue | null>(
  null,
);

const isWeb = Platform.OS === "web";

export function LocationTrackingProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isSignedIn, userId } = useAuth();
  const reportLocation = useReportStaffLocation();

  // The cleaner's explicit choice. We never track without this being true.
  const [enabled, setEnabled] = useState(false);
  const [consentLoaded, setConsentLoaded] = useState(false);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [canAskAgain, setCanAskAgain] = useState(true);
  const [lastSentAt, setLastSentAt] = useState<string | null>(null);

  // Refs let the interval callback read fresh values without re-subscribing.
  const watcherRef = useRef<Location.LocationSubscription | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const latestFixRef = useRef<Location.LocationObject | null>(null);
  const sendInFlightRef = useRef(false);
  const deviceKeyRef = useRef<string | null>(null);
  const reportRef = useRef(reportLocation);
  reportRef.current = reportLocation;

  const stopWatcher = useCallback(() => {
    if (watcherRef.current) {
      watcherRef.current.remove();
      watcherRef.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    latestFixRef.current = null;
  }, []);

  // Fire a single send from whatever the freshest fix is. Never throws — a
  // failed send just waits for the next tick.
  const sendOnce = useCallback(async () => {
    const fix = latestFixRef.current;
    if (!fix || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    try {
      // Named identity for this install, so the owner sees "iPhone" and
      // "iPad" as two pins rather than one that teleports between them.
      if (!deviceKeyRef.current) {
        deviceKeyRef.current = await loadDeviceKey();
      }
      const result = await reportRef.current.mutateAsync({
        data: {
          lat: fix.coords.latitude,
          lng: fix.coords.longitude,
          accuracy:
            typeof fix.coords.accuracy === "number"
              ? fix.coords.accuracy
              : null,
          deviceKey: deviceKeyRef.current,
          recoveryKey: deviceRecoveryKey(),
          deviceLabel: defaultDeviceLabel(),
          platform: devicePlatform(),
        },
      });
      setLastSentAt(result.updatedAt ?? new Date().toISOString());
    } catch {
      // Swallow: network / auth hiccups retry on the next interval rather
      // than surfacing an error or blocking the UI.
    } finally {
      sendInFlightRef.current = false;
    }
  }, []);

  const startWatcher = useCallback(async () => {
    if (isWeb || watcherRef.current) return;
    try {
      watcherRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: SEND_INTERVAL_MS,
          distanceInterval: 10,
        },
        (fix) => {
          latestFixRef.current = fix;
        },
      );
      // Seed an immediate fix so the first send doesn't wait a full tick.
      try {
        latestFixRef.current = await Location.getLastKnownPositionAsync();
      } catch {
        // best-effort only
      }
      if (!intervalRef.current) {
        intervalRef.current = setInterval(() => {
          void sendOnce();
        }, SEND_INTERVAL_MS);
      }
      // Kick off one send right away if we already have a position.
      void sendOnce();
    } catch {
      // If the watcher can't start, treat sharing as off so the UI is honest.
      stopWatcher();
    }
  }, [sendOnce, stopWatcher]);

  const enable = useCallback(async () => {
    if (isWeb) return;
    // A fresh attempt deserves a fresh answer from the server — the owner may
    // have just switched this person on.
    try {
      const current = await Location.getForegroundPermissionsAsync();
      let granted = current.granted;
      let ask = current.canAskAgain;
      if (!granted && current.canAskAgain) {
        const req = await Location.requestForegroundPermissionsAsync();
        granted = req.granted;
        ask = req.canAskAgain;
      }
      setPermissionGranted(granted);
      setCanAskAgain(ask);
      if (!granted) {
        // Denied: never flip the switch on, never loop-prompt.
        setEnabled(false);
        try {
          const key = await loadDeviceKey();
          await reportRef.current.mutateAsync({
            data: {
              lat: null,
              lng: null,
              accuracy: null,
              deviceKey: key,
              recoveryKey: deviceRecoveryKey(),
              deviceLabel: defaultDeviceLabel(),
              platform: devicePlatform(),
              locationHealth: "permission-denied",
            },
          });
        } catch {
          // The local recovery instruction remains the source of truth.
        }
        return;
      }
      if (userId) await markLocationConsent(userId);
      setEnabled(true);
    } catch {
      setEnabled(false);
    }
  }, [userId]);

  const disable = useCallback(() => {
    setEnabled(false);
    stopWatcher();
  }, [stopWatcher]);

  // Read the OS permission on mount so the status is accurate before the
  // user touches anything (e.g. they granted it in a previous session).
  useEffect(() => {
    if (isWeb) return;
    let cancelled = false;
    (async () => {
      try {
        if (!isSignedIn || !userId) {
          setConsentLoaded(false);
          setEnabled(false);
          return;
        }
        const consent = await hasLocationConsent(userId);
        if (cancelled) return;
        setConsentLoaded(true);
        const perm = await Location.getForegroundPermissionsAsync();
        if (cancelled) return;
        setPermissionGranted(perm.granted);
        setCanAskAgain(perm.canAskAgain);
        // A previous accepted decision resumes automatically, without showing
        // the system prompt again.
        if (consent && perm.granted) setEnabled(true);
      } catch {
        // ignore — defaults keep the UI in a safe "off" state
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, userId]);

  // Signing out must always kill the watcher and reset the switch — never
  // leave GPS running for a signed-out person.
  useEffect(() => {
    if (!isSignedIn) {
      setEnabled(false);
      setConsentLoaded(false);
      stopWatcher();
    }
  }, [isSignedIn, stopWatcher]);

  // The single source of truth for whether the watcher should be alive right
  // now: signed in + switch on + permission + the owner allows it + not web.
  // No clock check — the hours rule belongs to the server, in company time.
  const shouldTrack =
    !isWeb &&
    !!isSignedIn &&
    consentLoaded &&
    enabled &&
    permissionGranted &&
    true;

  useEffect(() => {
    if (shouldTrack) {
      void startWatcher();
    } else {
      stopWatcher();
    }
  }, [shouldTrack, startWatcher, stopWatcher]);

  // Pause the watcher when the app is backgrounded (foreground-only tracking)
  // and resume when it returns, so we never drain the battery in the
  // background.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        // Coming back to the app is the natural moment to find out whether the
        // owner has switched this person on since we last asked.
        if (shouldTrack) void startWatcher();
      } else {
        stopWatcher();
      }
    });
    return () => sub.remove();
  }, [shouldTrack, startWatcher, stopWatcher]);

  // Final safety net: tear everything down on unmount.
  useEffect(() => stopWatcher, [stopWatcher]);

  const status: TrackingStatus = useMemo(() => {
    if (isWeb) return "unsupported";
    if (enabled && !permissionGranted) return "denied";
    if (!enabled) return "off";
    return "sharing";
  }, [enabled, permissionGranted]);

  const value = useMemo<LocationTrackingValue>(
    () => ({
      status,
      enabled,
      permissionGranted,
      canAskAgain,
      blockedByOwner: false,
      lastSentAt,
      enable,
      disable,
    }),
    [
      status,
      enabled,
      permissionGranted,
      canAskAgain,
      lastSentAt,
      enable,
      disable,
    ],
  );

  return (
    <LocationTrackingContext.Provider value={value}>
      {children}
    </LocationTrackingContext.Provider>
  );
}

export function useLocationTracking(): LocationTrackingValue {
  const ctx = useContext(LocationTrackingContext);
  if (!ctx) {
    throw new Error(
      "useLocationTracking must be used within a LocationTrackingProvider",
    );
  }
  return ctx;
}
