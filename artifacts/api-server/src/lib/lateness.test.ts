import { describe, expect, it } from "vitest";
import {
  lateLegs,
  advanceLateAlerts,
  lateActivityMessage,
  type LatenessLeg,
} from "./lateness";

// Noon MDT — the same anchors as the web lateAlerts suite, so the server's
// port of the rule is provably reading the same clock the map does.
const NOW = Date.UTC(2026, 7, 9, 18, 0, 0);
const TZ = "America/Edmonton";

function leg(over: Partial<LatenessLeg> = {}): LatenessLeg {
  return {
    teamMemberId: 7,
    name: "Casey Cleaner",
    bookingId: 42,
    customerName: "Sarah M.",
    // Booked for 12:30, 15 min away → arrives 12:15, comfortably on time.
    scheduledFor: new Date(Date.UTC(2026, 7, 9, 18, 30, 0)).toISOString(),
    etaSeconds: 15 * 60,
    ...over,
  };
}

/** Booked for 11:00 while arriving 12:15 — 75 minutes behind. */
function lateLeg(over: Partial<LatenessLeg> = {}): LatenessLeg {
  return leg({
    scheduledFor: new Date(Date.UTC(2026, 7, 9, 17, 0, 0)).toISOString(),
    ...over,
  });
}

describe("lateLegs (server port of etaSummary's rule)", () => {
  it("agrees with the map's grace — 3 minutes behind is not late", () => {
    const routes = [
      leg({
        scheduledFor: new Date(Date.UTC(2026, 7, 9, 18, 12, 0)).toISOString(),
      }),
    ];
    expect(lateLegs(routes, TZ, NOW)).toEqual([]);
  });

  it("reports the same minutes and clock the map's card shows", () => {
    const out = lateLegs([lateLeg()], TZ, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      bookingId: 42,
      teamMemberId: 7,
      lateMins: 75,
      arriveClock: "12:15 PM",
    });
  });

  it("an unparsable booked time is unknowable, never late", () => {
    expect(lateLegs([lateLeg({ scheduledFor: "garbage" })], TZ, NOW)).toEqual(
      [],
    );
  });
});

describe("advanceLateAlerts", () => {
  it("raises the sweep a trail first crosses the line, and only then", () => {
    const first = advanceLateAlerts(new Map(), [lateLeg()], TZ, NOW);
    expect(first.fresh.map((l) => l.bookingId)).toEqual([42]);

    // Next sweep, later still — no repeat entry.
    const second = advanceLateAlerts(
      first.alerted,
      [lateLeg({ etaSeconds: 25 * 60 })],
      TZ,
      NOW,
    );
    expect(second.fresh).toEqual([]);
  });

  it("two late cleaners on one booking are one slip, one entry", () => {
    const state = advanceLateAlerts(
      new Map(),
      [lateLeg(), lateLeg({ teamMemberId: 8, name: "Riley" })],
      TZ,
      NOW,
    );
    expect(state.fresh).toHaveLength(1);
    expect(state.alerted.get(42)).toEqual(new Set([7, 8]));
  });

  it("a slip is forgiven only when seen back on time, then re-alerts", () => {
    const slipped = advanceLateAlerts(new Map(), [lateLeg()], TZ, NOW);

    // Trail disappears — still remembered, no forgiveness by absence.
    const gone = advanceLateAlerts(slipped.alerted, [], TZ, NOW);
    expect(gone.alerted.has(42)).toBe(true);

    // Flickers back, still late: no second entry for the same slip.
    const back = advanceLateAlerts(gone.alerted, [lateLeg()], TZ, NOW);
    expect(back.fresh).toEqual([]);

    // Seen visibly on time: forgiven — and reported as recovered so the
    // sweep can post the back-on-time entry.
    const recovered = advanceLateAlerts(back.alerted, [leg()], TZ, NOW);
    expect(recovered.alerted.has(42)).toBe(false);
    expect(recovered.recovered).toEqual([42]);

    // A later slip is news again.
    const again = advanceLateAlerts(recovered.alerted, [lateLeg()], TZ, NOW);
    expect(again.fresh.map((l) => l.bookingId)).toEqual([42]);
  });

  it("a seeded booking (restart) stays quiet while late, clears after", () => {
    // The sweep seeds restart state as bookingId → empty member set.
    const seeded = new Map<number, Set<number>>([[42, new Set()]]);

    const stillLate = advanceLateAlerts(seeded, [lateLeg()], TZ, NOW);
    expect(stillLate.fresh).toEqual([]);

    const overWith = advanceLateAlerts(stillLate.alerted, [leg()], TZ, NOW);
    expect(overWith.alerted.has(42)).toBe(false);
    expect(overWith.recovered).toEqual([42]);
  });
});

describe("lateActivityMessage", () => {
  it("reads like the map's toast, in feed form", () => {
    const [l] = lateLegs([lateLeg()], TZ, NOW);
    expect(lateActivityMessage(l!)).toBe(
      "Casey Cleaner is running late — heading to Sarah M., now arriving 12:15 PM (75 min past the booked time)",
    );
  });
});
