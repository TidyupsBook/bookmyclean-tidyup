/**
 * "This device" — the browser the dashboard is running in, as something the
 * map can track like any phone.
 *
 * The owner signs in from a PC, an Android, an iPad and an iPhone. Those used
 * to be one pin fighting over one row; now each is a device with its own
 * identity, and the desktop dashboard is simply another one of them. This
 * module owns the parts of that which are pure — the stable key kept in
 * localStorage, the default name, the platform guess, and the once-only
 * permission decision — so they can be tested without a browser.
 *
 * Nothing here reports anything. DeviceLocationReporter does that.
 */

/** What a device calls itself to the API. */
export type DevicePlatform = "web" | "ios" | "android" | "other";

/**
 * The device key is per signed-in user, not per browser profile: two people
 * sharing a machine must not inherit each other's pin, and the same person
 * coming back to this browser must keep theirs.
 */
export function deviceKeyStorageKey(who: string): string {
  return `bmc:device-key:${who || "anon"}`;
}

/** The name this device shows on the map, editable by its user. */
export function deviceLabelStorageKey(who: string): string {
  return `bmc:device-label:${who || "anon"}`;
}

/**
 * Whether this browser is sharing its location. Local on purpose: turning the
 * dashboard's own reporting on is a decision about *this machine*, separate
 * from the company-wide switch the owner sets for a person on the Tracking
 * page. A borrowed laptop must not start transmitting because the owner's
 * phone does.
 */
export function deviceSharingStorageKey(who: string): string {
  return `bmc:device-sharing:${who || "anon"}`;
}

/**
 * Remember that the browser has already been asked once. The Permissions API
 * answers this on its own where it exists, but Safari has historically not
 * exposed geolocation there — without a local record we'd re-prompt every
 * time the toggle was flipped, which is exactly the nagging the requirement
 * rules out.
 */
export function devicePromptedStorageKey(who: string): string {
  return `bmc:device-geo-asked:${who || "anon"}`;
}

/** A crude but sufficient read of what kind of machine this is. */
export function detectPlatform(userAgent: string): DevicePlatform {
  const ua = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  // iPadOS reports itself as a Mac; the touch check is the usual tell.
  if (/android/.test(ua)) return "android";
  return "web";
}

/** True for a phone or tablet browser, as opposed to a desktop one. */
export function isHandheld(userAgent: string): boolean {
  return /iphone|ipad|ipod|android|mobile/i.test(userAgent);
}

/**
 * What to call this device before anyone renames it.
 *
 * The owner's desktop is "Boss PC" — that is the name the office already uses
 * out loud for the machine in the corner, and the whole point of the yellow
 * pin is that the boss is identifiable at a glance rather than by squinting
 * at "Chrome 139".
 */
export function defaultDeviceName(opts: {
  isOwner: boolean;
  userAgent: string;
}): string {
  const handheld = isHandheld(opts.userAgent);
  const platform = detectPlatform(opts.userAgent);
  if (opts.isOwner) {
    if (!handheld) return "Boss PC";
    if (platform === "ios")
      return /ipad/i.test(opts.userAgent) ? "Boss iPad" : "Boss iPhone";
    if (platform === "android") return "Boss Android";
    return "Boss Phone";
  }
  if (!handheld) return "Computer";
  if (platform === "ios") return "iPhone";
  if (platform === "android") return "Android";
  return "Phone";
}

/** A random, opaque device key. Never derived from anything identifying. */
export function newDeviceKey(): string {
  const c = globalThis.crypto;
  if (c && "randomUUID" in c) return c.randomUUID();
  return `dev-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * A non-location browser fingerprint used only for a health-only recovery
 * report. It is intentionally coarse and scoped to the signed-in seat by the
 * API; it is not exposed to the map or used as an authorization credential.
 */
export function buildDeviceRecoveryKey(bits: string[]): string {
  let hash = 2166136261;
  for (const char of bits.join("|")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `recovery:${(hash >>> 0).toString(16)}`;
}

export function deviceRecoveryKey(): string {
  return buildDeviceRecoveryKey([
    navigator.userAgent,
    navigator.language,
    navigator.platform,
    String(navigator.hardwareConcurrency ?? ""),
    `${window.screen?.width ?? ""}x${window.screen?.height ?? ""}`,
    Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
  ]);
}

/**
 * The key for this browser, minted once and kept. A browser that can't write
 * to localStorage (private mode, storage disabled) still gets a working key —
 * it just won't survive a reload, which costs a duplicate device row rather
 * than a broken page.
 */
export function loadDeviceKey(who: string): string {
  const key = deviceKeyStorageKey(who);
  try {
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const minted = newDeviceKey();
    window.localStorage.setItem(key, minted);
    return minted;
  } catch {
    return newDeviceKey();
  }
}

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A browser that refuses storage still works, it just forgets.
  }
}

/** What the browser currently thinks about letting us read a position. */
export type GeoPermission = "granted" | "denied" | "prompt" | "unknown";

/**
 * Ask the browser what it has already decided, WITHOUT prompting.
 *
 * This is the whole "ask at most once" rule: a granted permission needs no
 * dialog, a denied one must never raise another (the browser wouldn't show it
 * anyway, so the user would just see nothing happen), and only a genuinely
 * undecided one is worth a prompt.
 */
export async function readGeoPermission(): Promise<GeoPermission> {
  try {
    const perms = navigator.permissions;
    if (!perms?.query) return "unknown";
    const status = await perms.query({
      name: "geolocation" as PermissionName,
    });
    if (status.state === "granted" || status.state === "denied") {
      return status.state;
    }
    return "prompt";
  } catch {
    return "unknown";
  }
}

/**
 * Should we put a permission dialog in front of the user right now?
 *
 * `unknown` (no Permissions API, e.g. older Safari) falls back to the local
 * "we already asked" record, so the one prompt still only happens once.
 */
export function shouldPrompt(
  permission: GeoPermission,
  askedBefore: boolean,
): boolean {
  if (permission === "granted" || permission === "denied") return false;
  if (permission === "prompt") return true;
  return !askedBefore;
}

/**
 * Should we put the one-time "show me on the map" ask in front of someone who
 * has just signed in?
 *
 * The rule the owner asked for is *ask once, on this device, and never nag*:
 *
 * - Nothing before the device's identity is known — `who` decides which
 *   localStorage record we'd be reading, and asking against "anon" would ask
 *   the next person all over again.
 * - Never when this browser is already sharing; there is nothing to ask for.
 * - Never after a refusal. A browser that has said no won't show another
 *   dialog anyway, so a second ask is a dead button.
 * - Otherwise exactly once per person per browser, whether they said yes, no,
 *   or closed it without answering.
 *
 * Note this deliberately asks even when the browser permission is already
 * granted: permission and *sharing* are different answers, and a machine with
 * permission but the switch off is a person missing from the map.
 */
export function shouldOfferLocationAtSignIn(opts: {
  ready: boolean;
  sharing: boolean;
  permission: GeoPermission;
  askedBefore: boolean;
}): boolean {
  if (!opts.ready) return false;
  if (opts.sharing) return false;
  if (opts.permission === "denied") return false;
  return !opts.askedBefore;
}

/** What to tell someone whose browser is refusing, instead of asking again. */
export const GEO_DENIED_HELP =
  "Your browser is blocking location for this site. Click the padlock (or the location icon) in the address bar, set Location to Allow, then reload this page.";
