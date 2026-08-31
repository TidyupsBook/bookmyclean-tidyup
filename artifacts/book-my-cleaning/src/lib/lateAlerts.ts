/**
 * "Warn dispatch the moment an arrival slips past the booked time."
 *
 * The map already computes lateness per trail (etaSummary) but only shows it
 * to someone hovering the chip or the cleaner's card. This module turns that
 * same rule into an active nudge: which trails are late right now, and which
 * of them are *newly* late — i.e. deserve one toast — given what has already
 * been announced.
 *
 * Pure on purpose (no React, no toasts) so the once-per-slip discipline is
 * unit-testable: the page keeps the returned `alerted` set between polls and
 * feeds it back in.
 */
import { etaSummary, type MapRouteLeg } from "./routeTrails";

export type LateLeg = {
  bookingId: number;
  teamMemberId: number;
  /** The cleaner running behind. */
  name: string;
  customerName: string;
  /** Minutes past the booked time — always > 0 here. */
  lateMins: number;
  /** Projected arrival as a clock time in the company zone. */
  arriveClock: string;
};

/**
 * Every trail currently projected to arrive late, judged by the exact rule
 * the map's chips and cards use (etaSummary, 5-minute grace). Never a second
 * definition of "late" — the alert and the map must always agree.
 */
export function lateLegs(
  routes: MapRouteLeg[],
  timeZone: string,
  nowMs: number = Date.now(),
): LateLeg[] {
  const out: LateLeg[] = [];
  for (const r of routes) {
    const s = etaSummary(r, timeZone, nowMs);
    if (s.lateMins === null) continue;
    out.push({
      bookingId: r.bookingId,
      teamMemberId: r.teamMemberId,
      name: r.name,
      customerName: r.customerName,
      lateMins: s.lateMins,
      arriveClock: s.arriveClock,
    });
  }
  return out;
}

/**
 * What has already been announced: per booking, the cleaners whose trail was
 * late when (or since) the alert fired. The member ids are what lets recovery
 * be judged against the *right* trail — another cleaner's on-time route to
 * the same job proves nothing about the one who slipped.
 */
export type AlertedBookings = ReadonlyMap<number, ReadonlySet<number>>;

export type LateAlertState = {
  /** Announced bookings and their late cleaners — carry into the next poll. */
  alerted: Map<number, Set<number>>;
  /** Trails that just crossed the line: toast these, once each. */
  fresh: LateLeg[];
  /** Everyone late right now, for the roster highlight. */
  lateNow: LateLeg[];
};

/**
 * One alert per booking per slip.
 *
 * - A booking becomes `fresh` only the poll a trail's ETA first crosses
 *   booked time + grace; subsequent polls stay quiet however late it gets,
 *   and a second assigned cleaner slipping on the same booking is the same
 *   slip, not a second toast.
 * - A booking is forgiven only when every trail that was late for it has
 *   been *seen* back on time (and nothing for it is late now) — if it slips
 *   again after that, that is a new slip and earns a new alert.
 * - A late trail that simply disappears (cleaner arrived, went stale, or the
 *   leg ended) stays remembered: a trail flickering out for one poll — even
 *   while a co-assignee's on-time trail is still visible — must not
 *   re-announce the same slip when it comes back.
 */
export function advanceLateAlerts(
  alreadyAlerted: AlertedBookings,
  routes: MapRouteLeg[],
  timeZone: string,
  nowMs: number = Date.now(),
): LateAlertState {
  const lateNow = lateLegs(routes, timeZone, nowMs);
  const lateByBooking = new Map<number, LateLeg[]>();
  for (const l of lateNow) {
    const list = lateByBooking.get(l.bookingId);
    if (list) list.push(l);
    else lateByBooking.set(l.bookingId, [l]);
  }

  const alerted = new Map<number, Set<number>>();
  for (const [bookingId, members] of alreadyAlerted) {
    // A remembered cleaner is cleared only when their own trail is visibly
    // on time again — absence proves nothing about punctuality.
    const remaining = new Set(members);
    for (const r of routes) {
      if (r.bookingId !== bookingId || !remaining.has(r.teamMemberId)) {
        continue;
      }
      const s = etaSummary(r, timeZone, nowMs);
      if (s.lateMins === null) remaining.delete(r.teamMemberId);
    }
    // Everyone who slipped has been seen recovering and nobody else is late
    // for it now: the slip is over, and a future one is news again.
    if (remaining.size === 0 && !lateByBooking.has(bookingId)) continue;
    alerted.set(bookingId, remaining);
  }

  // One toast per booking even within a single poll: a job with two assigned
  // cleaners produces two late legs the same instant, and dispatch needs one
  // heads-up about the booking, not one per crew member. (lateNow keeps every
  // leg on purpose — the roster highlight is per cleaner.)
  const fresh: LateLeg[] = [];
  for (const [bookingId, legs] of lateByBooking) {
    const members = alerted.get(bookingId);
    if (!members) {
      alerted.set(bookingId, new Set(legs.map((l) => l.teamMemberId)));
      fresh.push(legs[0]!);
      continue;
    }
    // Already announced — just remember every cleaner currently late on it.
    for (const l of legs) members.add(l.teamMemberId);
  }

  return { alerted, fresh, lateNow };
}

/** The toast copy for one newly late trail. */
export function lateAlertMessage(l: LateLeg): {
  title: string;
  description: string;
} {
  return {
    title: `${l.name} is running late`,
    description: `Heading to ${l.customerName} — now arriving ${l.arriveClock}, ${l.lateMins} min past the booked time. Worth a heads-up call to the customer.`,
  };
}

/** Set equality, so the roster-highlight state only changes when it changes. */
export function sameIdSet(
  a: ReadonlySet<number>,
  b: ReadonlySet<number>,
): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}
