/**
 * The one decision both maps share: which markers get drawn.
 *
 * The roster strip's hide list applies only to live cleaner positions. Homes,
 * client job pins and hand-dropped saved pins are places and must never be
 * filtered by it. This
 * file is deliberately pure (no React, no Maps SDK) so that rule is pinned by
 * unit tests instead of relying on two imperative drawing effects staying in
 * sync by hand.
 */
import { hasCoords } from "./mapMarkers";

/** The minimum a marker needs to be drawable: real coordinates. */
type MaybeLocated = { lat?: number | null; lng?: number | null };

/** People-markers additionally carry who they belong to. */
type PersonMarker = MaybeLocated & { teamMemberId: number };

/** Saved pins carry their own id, so they can be hidden individually. */
type PlacePin = MaybeLocated & { id: number };

export type MarkerSelection<
  C extends PersonMarker,
  J extends MaybeLocated,
  P extends PlacePin,
  S extends PersonMarker,
> = {
  /** Live cleaner positions to draw — coordful and not hidden. */
  cleaners: C[];
  /** Job pins to draw — coordful, NEVER filtered by either hide list. */
  jobs: J[];
  /** Saved pins to draw — coordful and not on the pin hide list. */
  pins: P[];
  /** Staff-home houses to draw — coordful and always visible. */
  staffHomes: S[];
};

/**
 * Decide which markers should be drawn, given the map payload and the two
 * hide lists: the roster strip's (people) and the saved-pin checkboxes'.
 *
 * - Anything without coordinates is skipped everywhere (it can't be drawn).
 * - Hidden team members lose their car (live position) — and nothing else.
 *   Their home stays visible as a permanent planning reference.
 * - Hidden saved pins disappear from the map — and nothing else. The two
 *   lists are separate on purpose: a pin id and a team-member id can
 *   collide, and neither list may hide the other's markers.
 * - Job pins ignore both lists entirely, by construction: their filter
 *   below never looks at either. A client's property can't be hidden.
 */
export function selectMapMarkers<
  C extends PersonMarker,
  J extends MaybeLocated,
  P extends PlacePin,
  S extends PersonMarker,
>(
  data:
    | {
        cleaners?: C[];
        jobs?: J[];
        pins?: P[];
        staffHomes?: S[];
      }
    | undefined,
  hiddenCleaners: Set<number>,
  hiddenPins: Set<number>,
): MarkerSelection<C, J, P, S> {
  return {
    cleaners: (data?.cleaners ?? []).filter(
      (c) => hasCoords(c) && !hiddenCleaners.has(c.teamMemberId),
    ),
    jobs: (data?.jobs ?? []).filter(hasCoords),
    pins: (data?.pins ?? []).filter(
      (p) => hasCoords(p) && !hiddenPins.has(p.id),
    ),
    staffHomes: (data?.staffHomes ?? []).filter(hasCoords),
  };
}

/**
 * The points the viewport frames are exactly the markers that were drawn —
 * in draw order (cleaners, jobs, pins, staff homes), matching how both maps
 * accumulate them. Kept here so "what we frame" can't drift from "what we
 * draw" without a test noticing.
 */
export function selectionFramePoints(
  selection: MarkerSelection<
    PersonMarker & { lat: number; lng: number },
    MaybeLocated,
    PlacePin,
    PersonMarker
  >,
): { lat: number; lng: number }[] {
  const all = [
    ...selection.cleaners,
    ...selection.jobs,
    ...selection.pins,
    ...selection.staffHomes,
  ];
  return all
    .filter(hasCoords)
    .map((m) => ({ lat: m.lat as number, lng: m.lng as number }));
}
