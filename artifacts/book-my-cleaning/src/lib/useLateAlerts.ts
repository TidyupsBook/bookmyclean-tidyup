/**
 * The map page's lateness nudge, as a hook so the role gate and the
 * once-per-slip discipline are testable without mounting Google Maps.
 *
 * The poll a trail's projected arrival first slips past booked time + grace
 * (etaSummary's rule, via advanceLateAlerts), `notify` fires once — not again
 * on every 30-second refresh — and the returned set marks the cleaners whose
 * trails are currently late, for the roster strip's amber highlight.
 *
 * Dispatch-only by contract: while `isDispatch` is false (a cleaner watching
 * their own trail, or a role still loading / just revoked) nothing is
 * announced AND any previously accumulated state is dropped, so a role
 * switch without an unmount can't leave privileged UI behind.
 */
import { useEffect, useRef, useState } from "react";
import {
  advanceLateAlerts,
  lateAlertMessage,
  sameIdSet,
  type LateLeg,
} from "./lateAlerts";
import type { MapRouteLeg } from "./routeTrails";

const EMPTY: Set<number> = new Set();

export function useLateAlerts(
  routes: MapRouteLeg[] | undefined,
  timeZone: string,
  isDispatch: boolean,
  notify: (msg: { title: string; description: string }, leg: LateLeg) => void,
): Set<number> {
  const [lateCleaners, setLateCleaners] = useState<Set<number>>(EMPTY);
  // Bookings already announced (and which cleaners were late on them). A
  // ref, not state: it must advance between polls without ever being a
  // render dependency of anything.
  const alertedRef = useRef<Map<number, Set<number>>>(new Map());
  // The toast function's identity changes per render in some setups; the
  // alert beat is the poll, never a re-render.
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  useEffect(() => {
    if (!isDispatch) {
      // Not (or no longer) dispatch: forget everything, show nothing.
      alertedRef.current = new Map();
      setLateCleaners((prev) => (prev.size === 0 ? prev : EMPTY));
      return;
    }
    const { alerted, fresh, lateNow } = advanceLateAlerts(
      alertedRef.current,
      routes ?? [],
      timeZone,
    );
    alertedRef.current = alerted;
    const lateIds = new Set(lateNow.map((l) => l.teamMemberId));
    // Only touch state when membership actually changed, or every poll would
    // re-render (and re-run the map's marker redraw) for nothing.
    setLateCleaners((prev) => (sameIdSet(prev, lateIds) ? prev : lateIds));
    for (const l of fresh) notifyRef.current(lateAlertMessage(l), l);
  }, [routes, timeZone, isDispatch]);

  return lateCleaners;
}
