/**
 * Whether the Map tab draws the line from each cleaner to their next job.
 *
 * The owner's own view preference, kept on the phone rather than the server:
 * it decides what one person is looking at, not what the company may see, so
 * switching trails off on the boss's iPad leaves dispatch's map untouched.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_PREFIX = "bmc.show-trails.v1";

/** One slot per signed-in person, so a shared tablet doesn't share the choice. */
export function showTrailsKey(who: string): string {
  return `${STORAGE_PREFIX}:${who || "anon"}`;
}

/**
 * Trails are on unless this phone has been told otherwise. Anything else —
 * never set, unreadable, junk — reads as on, so a bad value can't quietly
 * strip the map of information the owner expects to be there.
 */
export function parseShowTrails(raw: string | null): boolean {
  return raw !== "off";
}

export async function loadShowTrails(who: string): Promise<boolean> {
  try {
    return parseShowTrails(await AsyncStorage.getItem(showTrailsKey(who)));
  } catch {
    return true;
  }
}

export async function saveShowTrails(
  who: string,
  show: boolean,
): Promise<void> {
  try {
    await AsyncStorage.setItem(showTrailsKey(who), show ? "on" : "off");
  } catch {
    // Storage can be unavailable; the switch still works for this session.
  }
}
