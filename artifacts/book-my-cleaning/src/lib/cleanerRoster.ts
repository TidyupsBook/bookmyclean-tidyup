/**
 * The cleaner roster strip on the maps — one chip per active crew member,
 * with a show/hide toggle and a click-to-focus target.
 *
 * Pure on purpose (no React, no Maps SDK) so the merge rules and the
 * persistence round-trip can be unit-tested. The hide list is stored locally,
 * per signed-in user, so the choice survives navigating around the app but
 * never leaks between people sharing a machine account-by-account.
 */
import type {
  MapCleaner,
  StaffHome,
  StaffWithoutHome,
} from "@workspace/api-client-react";
import { STALE_AFTER_MS, hasCoords } from "./mapMarkers";

export type RosterFocus = {
  lat: number;
  lng: number;
  /** Fresh GPS beats the home address; a quiet phone falls back to home. */
  source: "live" | "home";
};

export type RosterCleaner = {
  teamMemberId: number;
  name: string;
  color?: string | null;
  /** Null when we have no coordinates at all for this person. */
  focus: RosterFocus | null;
  /** True when their phone reported in within the staleness window. */
  live: boolean;
};

/**
 * One chip per active crew member, whether or not they are on the map yet.
 *
 * Someone with no coordinates still gets a chip — leaving them off would make
 * the roster look like the company shrank — their chip just can't be jumped
 * to. A live position that is still fresh wins over the home address as the
 * click target; a stale one is ignored, exactly like the ranking panel does.
 */
export function buildRoster(
  data:
    | {
        cleaners?: MapCleaner[];
        staffHomes?: StaffHome[];
        staffWithoutHome?: StaffWithoutHome[];
      }
    | undefined,
  now: number = Date.now(),
): RosterCleaner[] {
  if (!data) return [];
  const byId = new Map<number, RosterCleaner>();

  for (const s of data.staffWithoutHome ?? []) {
    if (!s.active) continue;
    byId.set(s.teamMemberId, {
      teamMemberId: s.teamMemberId,
      name: s.name,
      color: null,
      focus: null,
      live: false,
    });
  }

  for (const home of data.staffHomes ?? []) {
    if (!home.active) continue;
    byId.set(home.teamMemberId, {
      teamMemberId: home.teamMemberId,
      name: home.name,
      color: home.color,
      focus: hasCoords(home)
        ? { lat: home.lat, lng: home.lng, source: "home" }
        : null,
      live: false,
    });
  }

  // Positions come one per DEVICE, and the roster is one chip per PERSON.
  // Collapse to whichever of somebody's devices spoke most recently, so a
  // phone and a tablet are one chip pointing at where they actually are —
  // not two chips, and not the tablet left behind at the last job.
  const freshestByMember = new Map<number, MapCleaner>();
  for (const c of data.cleaners ?? []) {
    if (!hasCoords(c)) continue;
    const seen = freshestByMember.get(c.teamMemberId);
    if (
      !seen ||
      new Date(c.updatedAt).getTime() > new Date(seen.updatedAt).getTime()
    ) {
      freshestByMember.set(c.teamMemberId, c);
    }
  }

  for (const c of freshestByMember.values()) {
    const reportedAt = new Date(c.updatedAt).getTime();
    const fresh =
      !Number.isNaN(reportedAt) && now - reportedAt <= STALE_AFTER_MS;
    const existing = byId.get(c.teamMemberId);
    // A transmitting device proves the person exists even without a
    // staff-home row; but only a *fresh* report replaces the home as the
    // click target.
    byId.set(c.teamMemberId, {
      teamMemberId: c.teamMemberId,
      name: existing?.name ?? c.name,
      color: c.color ?? existing?.color,
      focus: fresh
        ? { lat: c.lat, lng: c.lng, source: "live" }
        : (existing?.focus ?? { lat: c.lat, lng: c.lng, source: "live" }),
      live: fresh,
    });
  }

  return [...byId.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

/** One storage key per signed-in user, so households don't share a hide list. */
export function hiddenCleanersKey(who: string): string {
  return `bmc:hidden-cleaners:${who || "anon"}`;
}

/**
 * Saved map pins have their own hide list, same per-user rule. Kept beside
 * the cleaner key so every locally-stored hide list is defined in one place.
 * The load/save/toggle helpers below are shape-generic (a stored Set of ids)
 * and are shared by both lists.
 */
export function hiddenPinsKey(who: string): string {
  return `bmc:hidden-pins:${who || "anon"}`;
}

/**
 * Whether the map draws the line from each cleaner to their next job.
 *
 * The owner's own view preference, saved per user beside the two hide lists.
 * A dispatcher's map is unaffected by what the boss switches off here — this
 * decides what one person is looking at, not what the company may see.
 */
export function showTrailsKey(who: string): string {
  return `bmc:show-trails:${who || "anon"}`;
}

/** Whether this viewer has folded the cleaner roster down to its header. */
export function rosterCollapsedKey(who: string): string {
  return `bmc:cleaner-roster-collapsed:${who || "anon"}`;
}

/**
 * The roster starts open. Only the exact stored value "yes" collapses it, so
 * corrupt storage can never make the cleaner controls silently disappear.
 */
export function loadRosterCollapsed(
  storage: Pick<Storage, "getItem"> | null,
  key: string,
): boolean {
  try {
    return storage?.getItem(key) === "yes";
  } catch {
    return false;
  }
}

export function saveRosterCollapsed(
  storage: Pick<Storage, "setItem"> | null,
  key: string,
  collapsed: boolean,
): void {
  try {
    storage?.setItem(key, collapsed ? "yes" : "no");
  } catch {
    // A blocked localStorage still leaves a working in-page collapse control.
  }
}

/**
 * Trails are on unless this device has been told otherwise. Anything
 * unreadable reads as on, so a corrupt value can never quietly strip the map
 * of information the owner is expecting.
 */
export function loadShowTrails(
  storage: Pick<Storage, "getItem"> | null,
  key: string,
): boolean {
  try {
    return storage?.getItem(key) !== "off";
  } catch {
    return true;
  }
}

export function saveShowTrails(
  storage: Pick<Storage, "setItem"> | null,
  key: string,
  show: boolean,
): void {
  try {
    storage?.setItem(key, show ? "on" : "off");
  } catch {
    // Storage can be full or blocked; the toggle still works for this page.
  }
}

/**
 * Read the hide list back. Anything unreadable — corrupt JSON, the wrong
 * shape, storage disabled — is an empty list: the worst failure mode here is
 * silently hiding somebody's crew, so bad data always means "show everyone".
 */
export function loadHiddenCleaners(
  storage: Pick<Storage, "getItem"> | null,
  key: string,
): Set<number> {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is number => typeof v === "number"));
  } catch {
    return new Set();
  }
}

export function saveHiddenCleaners(
  storage: Pick<Storage, "setItem"> | null,
  key: string,
  hidden: Set<number>,
): void {
  try {
    storage?.setItem(key, JSON.stringify([...hidden].sort((a, b) => a - b)));
  } catch {
    // Storage can be full or blocked; the toggle still works for this page.
  }
}

/** Flip one cleaner's visibility, returning a new set (React state friendly). */
export function toggleHidden(hidden: Set<number>, id: number): Set<number> {
  const next = new Set(hidden);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
