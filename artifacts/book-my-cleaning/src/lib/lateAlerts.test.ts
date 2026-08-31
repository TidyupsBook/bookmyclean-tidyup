import { describe, expect, it } from "vitest";
import {
  lateLegs,
  advanceLateAlerts,
  lateAlertMessage,
  sameIdSet,
} from "./lateAlerts";
import type { MapRouteLeg } from "./routeTrails";

// Noon MDT on the test day — same anchors as routeTrails.test.ts so the two
// suites read against the same clock.
const NOW = Date.UTC(2026, 7, 9, 18, 0, 0);
const TZ = "America/Edmonton";

function leg(over: Partial<MapRouteLeg> = {}): MapRouteLeg {
  return {
    teamMemberId: 7,
    name: "Casey Cleaner",
    color: null,
    bookingId: 42,
    customerName: "Sarah M.",
    customerAddress: "12 Oak St",
    destLat: 53.56,
    destLng: -113.51,
    // Booked for 12:30, 15 min away → arrives 12:15, comfortably on time.
    scheduledFor: new Date(Date.UTC(2026, 7, 9, 18, 30, 0)).toISOString(),
    etaSeconds: 15 * 60,
    distanceMeters: 8400,
    source: "google",
    path: [
      { lat: 53.54, lng: -113.49 },
      { lat: 53.56, lng: -113.51 },
    ],
    ...over,
  };
}

/** Booked for 11:00 while arriving 12:15 — 75 minutes behind. */
function lateLeg(over: Partial<MapRouteLeg> = {}): MapRouteLeg {
  return leg({
    scheduledFor: new Date(Date.UTC(2026, 7, 9, 17, 0, 0)).toISOString(),
    ...over,
  });
}

describe("lateLegs", () => {
  it("agrees with etaSummary's grace — 3 minutes behind is not late", () => {
    // Booked 12:12, arriving 12:15: inside the 5-minute grace.
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
      name: "Casey Cleaner",
      customerName: "Sarah M.",
      lateMins: 75,
      arriveClock: "12:15 PM",
    });
  });
});

describe("advanceLateAlerts", () => {
  it("announces a trail the poll it first crosses the line, and only then", () => {
    const first = advanceLateAlerts(new Map(), [lateLeg()], TZ, NOW);
    expect(first.fresh.map((l) => l.bookingId)).toEqual([42]);

    // Next poll, still late (later still, even) — no repeat nag.
    const second = advanceLateAlerts(
      first.alerted,
      [lateLeg({ etaSeconds: 25 * 60 })],
      TZ,
      NOW,
    );
    expect(second.fresh).toEqual([]);
    expect(second.lateNow.map((l) => l.bookingId)).toEqual([42]);
  });

  it("re-alerts only after a visible recovery — a new slip is new news", () => {
    const slipped = advanceLateAlerts(new Map(), [lateLeg()], TZ, NOW);

    // Traffic clears: the same booking's trail is back on time.
    const recovered = advanceLateAlerts(slipped.alerted, [leg()], TZ, NOW);
    expect(recovered.fresh).toEqual([]);
    expect(recovered.lateNow).toEqual([]);
    expect(recovered.alerted.has(42)).toBe(false);

    // It slips again — that's a second slip and worth a second alert.
    const again = advanceLateAlerts(recovered.alerted, [lateLeg()], TZ, NOW);
    expect(again.fresh.map((l) => l.bookingId)).toEqual([42]);
  });

  it("does not forgive a booking whose trail merely disappeared", () => {
    const slipped = advanceLateAlerts(new Map(), [lateLeg()], TZ, NOW);

    // The trail flickers out for one poll (stale phone, leg ended)...
    const gone = advanceLateAlerts(slipped.alerted, [], TZ, NOW);
    expect(gone.alerted.has(42)).toBe(true);

    // ...and comes back still late: same slip, no second toast.
    const back = advanceLateAlerts(gone.alerted, [lateLeg()], TZ, NOW);
    expect(back.fresh).toEqual([]);
  });

  it("doesn't treat a co-assignee's on-time trail as the late cleaner recovering", () => {
    // Cleaner 7 is late, cleaner 9 is on time — for the same booking.
    const slipped = advanceLateAlerts(
      new Map(),
      [lateLeg(), leg({ teamMemberId: 9, name: "Riley Cleaner" })],
      TZ,
      NOW,
    );
    expect(slipped.fresh).toHaveLength(1);

    // Cleaner 7's trail flickers out while 9's on-time trail stays visible:
    // that says nothing about 7, so the slip is still remembered.
    const flicker = advanceLateAlerts(
      slipped.alerted,
      [leg({ teamMemberId: 9, name: "Riley Cleaner" })],
      TZ,
      NOW,
    );
    expect(flicker.alerted.has(42)).toBe(true);

    // Cleaner 7 comes back, still late — same slip, no second toast.
    const back = advanceLateAlerts(
      flicker.alerted,
      [lateLeg(), leg({ teamMemberId: 9, name: "Riley Cleaner" })],
      TZ,
      NOW,
    );
    expect(back.fresh).toEqual([]);

    // Only once cleaner 7 is *seen* on time does the booking reset — and a
    // later slip is announced again.
    const recovered = advanceLateAlerts(
      back.alerted,
      [leg(), leg({ teamMemberId: 9, name: "Riley Cleaner" })],
      TZ,
      NOW,
    );
    expect(recovered.alerted.has(42)).toBe(false);
    const again = advanceLateAlerts(recovered.alerted, [lateLeg()], TZ, NOW);
    expect(again.fresh).toHaveLength(1);
  });

  it("toasts a two-cleaner booking once, not once per late leg", () => {
    // Same booking, two assigned cleaners, both trails late the same poll.
    const routes = [
      lateLeg(),
      lateLeg({ teamMemberId: 9, name: "Riley Cleaner" }),
    ];
    const state = advanceLateAlerts(new Map(), routes, TZ, NOW);
    expect(state.fresh).toHaveLength(1);
    expect(state.fresh[0]!.bookingId).toBe(42);
    // The roster highlight still marks both cleaners as running late.
    expect(state.lateNow.map((l) => l.teamMemberId).sort()).toEqual([7, 9]);
  });

  it("tracks each booking independently", () => {
    const routes = [
      lateLeg(),
      leg({ teamMemberId: 9, bookingId: 77, name: "Riley Cleaner" }),
    ];
    const state = advanceLateAlerts(new Map(), routes, TZ, NOW);
    expect(state.fresh.map((l) => l.bookingId)).toEqual([42]);

    // The second cleaner slips on a later poll — only they are announced.
    const later = advanceLateAlerts(
      state.alerted,
      [
        lateLeg(),
        lateLeg({ teamMemberId: 9, bookingId: 77, name: "Riley Cleaner" }),
      ],
      TZ,
      NOW,
    );
    expect(later.fresh.map((l) => l.bookingId)).toEqual([77]);
    expect(later.lateNow.map((l) => l.bookingId).sort()).toEqual([42, 77]);
  });
});

describe("lateAlertMessage", () => {
  it("names the cleaner, the customer and the projected arrival", () => {
    const [l] = lateLegs([lateLeg()], TZ, NOW);
    const msg = lateAlertMessage(l!);
    expect(msg.title).toBe("Casey Cleaner is running late");
    expect(msg.description).toContain("Sarah M.");
    expect(msg.description).toContain("12:15 PM");
    expect(msg.description).toContain("75 min past the booked time");
  });
});

describe("sameIdSet", () => {
  it("treats equal contents as equal and anything else as not", () => {
    expect(sameIdSet(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    expect(sameIdSet(new Set([1]), new Set([1, 2]))).toBe(false);
    expect(sameIdSet(new Set([1, 3]), new Set([1, 2]))).toBe(false);
  });
});
