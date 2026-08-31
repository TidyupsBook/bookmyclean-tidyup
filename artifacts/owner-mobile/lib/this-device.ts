import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Identity for *this* phone.
 *
 * The server tracks devices, not people: one person signed in on a phone and a
 * tablet is two pins. That only works if each install sends a stable key of
 * its own — without one every device of theirs collapses onto a single legacy
 * pin that jumps between them.
 */

export const DEVICE_KEY_STORAGE = "bmc.device-key.v1";

export type DevicePlatform = "ios" | "android" | "web";

export function devicePlatform(os: string = Platform.OS): DevicePlatform {
  if (os === "ios") return "ios";
  if (os === "android") return "android";
  return "web";
}

/**
 * A first name for the device, shown on the owner's map and tracking page.
 * The owner can rename it from the dashboard later; this is only the default.
 */
export function defaultDeviceLabel(
  os: string = Platform.OS,
  isPad: boolean = Platform.OS === "ios" &&
    (Platform as { isPad?: boolean }).isPad === true,
): string {
  if (os === "ios") return isPad ? "iPad" : "iPhone";
  if (os === "android") return "Android";
  return "Computer";
}

/** A key nothing else will collide with, generated once per install. */
export function newDeviceKey(seed: string): string {
  return `dev-${seed}`;
}

/** Stable coarse identity for recovery after AsyncStorage is cleared. */
export function deviceRecoveryKey(): string {
  return `recovery:${devicePlatform()}-${String(Platform.Version)}-${Platform.OS === "ios" && (Platform as { isPad?: boolean }).isPad ? "tablet" : "phone"}`;
}

/**
 * The stored key, creating one on first run. Storage failures fall back to an
 * in-memory key: a pin that resets on restart still beats no pin at all.
 */
let cached: string | null = null;

export async function loadDeviceKey(): Promise<string> {
  if (cached) return cached;
  try {
    const stored = await AsyncStorage.getItem(DEVICE_KEY_STORAGE);
    if (stored) {
      cached = stored;
      return stored;
    }
  } catch {
    // fall through and mint a fresh one
  }
  const key = newDeviceKey(
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  );
  cached = key;
  try {
    await AsyncStorage.setItem(DEVICE_KEY_STORAGE, key);
  } catch {
    // in-memory only for this session
  }
  return key;
}

/** Test seam — forget the cached key so a fresh load hits storage again. */
export function resetDeviceKeyCache(): void {
  cached = null;
}

/**
 * Whether this phone has already put the "share your location?" question to a
 * given person. Keyed by user, not just by install: a phone handed to a new
 * cleaner asks them too, and does not inherit the last person's answer.
 */
export function locationAskedStorageKey(who: string): string {
  return `bmc.location-asked.v1:${who || "anon"}`;
}

export function locationConsentStorageKey(who: string): string {
  return `bmc.location-consent.v1:${who || "anon"}`;
}

export async function hasAskedForLocation(who: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(locationAskedStorageKey(who))) === "1";
  } catch {
    // A phone that can't read storage is better asked than silently skipped.
    return false;
  }
}

export async function markAskedForLocation(who: string): Promise<void> {
  try {
    await AsyncStorage.setItem(locationAskedStorageKey(who), "1");
  } catch {
    // Only costs one extra ask next launch.
  }
}

export async function hasLocationConsent(who: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(locationConsentStorageKey(who))) === "1";
  } catch {
    return false;
  }
}

export async function markLocationConsent(who: string): Promise<void> {
  try {
    await AsyncStorage.setItem(locationConsentStorageKey(who), "1");
  } catch {
    // A storage failure only affects resume on the next launch.
  }
}

/**
 * Should we ask this person, right now, whether to share their location?
 *
 * "Ask once, then never nag" — the same rule the dashboard follows:
 *
 * - Never on web; that build can't report a position at all, so the question
 *   would be meaningless.
 * - Never before we know whether they've been asked (`askedBefore` is null
 *   until storage answers) — asking on a hunch is how you ask twice.
 * - Never when sharing is already on.
 * - Never when the OS has refused for good (`canAskAgain` false and no
 *   permission): the system dialog would not appear, so the button would do
 *   nothing visible. The Location tab offers "Open Settings" for that case.
 *
 * Note we still ask when the OS permission is already granted but the switch
 * is off: permission and sharing are two different answers, and a phone with
 * permission but the switch off is a cleaner missing from the map.
 */
export function shouldOfferLocationAtSignIn(opts: {
  supported: boolean;
  signedIn: boolean;
  enabled: boolean;
  permissionGranted: boolean;
  canAskAgain: boolean;
  askedBefore: boolean | null;
}): boolean {
  if (!opts.supported || !opts.signedIn) return false;
  if (opts.askedBefore !== false) return false;
  if (opts.enabled) return false;
  if (!opts.permissionGranted && !opts.canAskAgain) return false;
  return true;
}
