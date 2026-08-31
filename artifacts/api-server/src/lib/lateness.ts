/**
 * Server-side lateness rule and once-per-slip discipline.
 *
 * This is the same rule the live map applies in the browser
 * (artifacts/book-my-cleaning/src/lib/routeTrails.ts `etaSummary` and
 * lateAlerts.ts `advanceLateAlerts`), ported here so a "running late" event
 * can be raised centrally — into the dashboard activity feed — even when
 * nobody has the map open. The grace period and the rounding MUST stay
 * identical to routeTrails.ts, or the feed and the map will disagree about
 * who is late.
 */

/** Arriving later than this after the booked time counts as running behind. */
const LATE_GRACE_MS = 5 * 60_000; // keep in lockstep with routeTrails.ts

/** The activity `type` for a running-late feed entry. */
export const LATE_ACTIVITY_TYPE = "cleaner_running_late";

/**
 * The activity `type` written when a slip ends. Besides telling dispatch the
 * scramble is over, this row is what makes the once-per-slip rule durable:
 * after a restart, a booking counts as still-announced only when its latest
 * entry is the late one — so a recovery followed by a new slip is correctly
 * news again even if the process bounced in between.
 */
export const RECOVERED_ACTIVITY_TYPE = "cleaner_back_on_time";

/** The slice of a route leg the lateness rule needs. */
export type LatenessLeg = {
  teamMemberId: number;
  name: string;
  bookingId: number;
  customerName: string;
  /** ISO timestamp of the booked time. */
  scheduledFor: string;
  etaSeconds: number;
};

export type LateLeg = {
  bookingId: number;
  teamMemberId: number;
  name: string;
  customerName: string;
  /** Minutes past the booked time — always > 0 here. */
  lateMins: number;
  /** Projected arrival as a clock time in the company zone. */
  arriveClock: string;
};

/** "2:45 PM" in the company's zone (never the server's). */
function clockInZone(ms: number, timeZone: string): string {
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    })
      .format(ms)
      // Newer ICU inserts a narrow no-break space before AM/PM; normalize so
      // the message (and tests) read the same everywhere.
      .replace(/[\u202f\u00a0]/g, " ")
  );
}

/** Minutes behind the booked time, or null when on time / unknowable. */
export function lateMinutes(
  leg: { etaSeconds: number; scheduledFor: string },
  nowMs: number,
): number | null {
  const arriveMs = nowMs + leg.etaSeconds * 1000;
  const scheduledMs = Date.parse(leg.scheduledFor);
  return Number.isFinite(scheduledMs) && arriveMs > scheduledMs + LATE_GRACE_MS
    ? Math.round((arriveMs - scheduledMs) / 60_000)
    : null;
}

/** Every trail currently projected to arrive late. */
export function lateLegs(
  routes: LatenessLeg[],
  timeZone: string,
  nowMs: number,
): LateLeg[] {
  const out: LateLeg[] = [];
  for (const r of routes) {
    const mins = lateMinutes(r, nowMs);
    if (mins === null) continue;
    out.push({
      bookingId: r.bookingId,
      teamMemberId: r.teamMemberId,
      name: r.name,
      customerName: r.customerName,
      lateMins: mins,
      arriveClock: clockInZone(nowMs + r.etaSeconds * 1000, timeZone),
    });
  }
  return out;
}

/**
 * What has already been announced: per booking, the cleaners whose trail was
 * late when (or since) the alert fired.
 */
export type AlertedBookings = ReadonlyMap<number, ReadonlySet<number>>;

export type LateAlertState = {
  /** Announced bookings and their late cleaners — carry into the next sweep. */
  alerted: Map<number, Set<number>>;
  /** Trails that just crossed the line: one feed entry each. */
  fresh: LateLeg[];
  /** Bookings whose slip just ended: everyone seen back on time. */
  recovered: number[];
};

/**
 * One alert per booking per slip — the exact discipline of the map page's
 * lateAlerts.ts, applied to the server's sweep interval instead of the
 * browser's poll:
 *
 * - A booking is `fresh` only the sweep a trail's ETA first crosses booked
 *   time + grace; a second assigned cleaner slipping on the same booking is
 *   the same slip, not a second entry.
 * - A booking is forgiven only when every trail that was late for it has
 *   been *seen* back on time (and nothing for it is late now); a later slip
 *   is news again.
 * - A late trail that simply disappears (arrived, went stale, leg ended)
 *   stays remembered, so a flicker can't re-announce the same slip.
 */
export function advanceLateAlerts(
  alreadyAlerted: AlertedBookings,
  routes: LatenessLeg[],
  timeZone: string,
  nowMs: number,
): LateAlertState {
  const lateNow = lateLegs(routes, timeZone, nowMs);
  const lateByBooking = new Map<number, LateLeg[]>();
  for (const l of lateNow) {
    const list = lateByBooking.get(l.bookingId);
    if (list) list.push(l);
    else lateByBooking.set(l.bookingId, [l]);
  }

  const alerted = new Map<number, Set<number>>();
  const recovered: number[] = [];
  for (const [bookingId, members] of alreadyAlerted) {
    // A remembered cleaner is cleared only when their own trail is visibly
    // on time again — absence proves nothing about punctuality.
    const remaining = new Set(members);
    for (const r of routes) {
      if (r.bookingId !== bookingId || !remaining.has(r.teamMemberId)) {
        continue;
      }
      if (lateMinutes(r, nowMs) === null) remaining.delete(r.teamMemberId);
    }
    if (remaining.size === 0 && !lateByBooking.has(bookingId)) {
      recovered.push(bookingId);
      continue;
    }
    alerted.set(bookingId, remaining);
  }

  const fresh: LateLeg[] = [];
  for (const [bookingId, legs] of lateByBooking) {
    const members = alerted.get(bookingId);
    if (!members) {
      alerted.set(bookingId, new Set(legs.map((l) => l.teamMemberId)));
      fresh.push(legs[0]!);
      continue;
    }
    for (const l of legs) members.add(l.teamMemberId);
  }

  return { alerted, fresh, recovered };
}

/** The feed entry copy for one newly late trail. */
export function lateActivityMessage(l: LateLeg): string {
  return `${l.name} is running late — heading to ${l.customerName}, now arriving ${l.arriveClock} (${l.lateMins} min past the booked time)`;
}

/** The feed entry copy for a slip that has ended. */
export function recoveredActivityMessage(customerName: string | null): string {
  return customerName
    ? `Back on schedule for ${customerName} — the earlier delay has cleared`
    : "Back on schedule — the earlier delay has cleared";
}
