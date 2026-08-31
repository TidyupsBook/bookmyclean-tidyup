import { describe, expect, it } from "vitest";
import {
  visibleTrails,
  midpointOf,
  clockInZone,
  etaSummary,
  chipLabel,
  headingLabel,
  type MapRouteLeg,
} from "./routeTrails";

// Noon MDT on the test day.
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

describe("visibleTrails", () => {
  it("drops trails for cleaners hidden on the roster strip", () => {
    const routes = [leg({ teamMemberId: 7 }), leg({ teamMemberId: 9 })];
    const shown = visibleTrails(routes, new Set([7]));
    expect(shown.map((r) => r.teamMemberId)).toEqual([9]);
  });
});

describe("midpointOf", () => {
  it("averages a straight two-point line so the chip isn't on the house", () => {
    const mid = midpointOf([
      { lat: 10, lng: 20 },
      { lat: 12, lng: 26 },
    ]);
    expect(mid).toEqual({ lat: 11, lng: 23 });
  });

  it("takes the middle vertex of a real route", () => {
    const mid = midpointOf([
      { lat: 1, lng: 1 },
      { lat: 2, lng: 2 },
      { lat: 3, lng: 3 },
      { lat: 4, lng: 4 },
      { lat: 5, lng: 5 },
    ]);
    expect(mid).toEqual({ lat: 3, lng: 3 });
  });

  it("handles empty and single-point paths", () => {
    expect(midpointOf([])).toBeNull();
    expect(midpointOf([{ lat: 1, lng: 2 }])).toEqual({ lat: 1, lng: 2 });
  });
});

describe("eta copy", () => {
  it("formats the arrival clock in the company zone", () => {
    expect(clockInZone(NOW, TZ)).toBe("12:00 PM");
  });

  it("reads on time when arrival beats the booked time", () => {
    // 15 min away, booked for 12:30 — arrives 12:15, on time.
    const s = etaSummary(leg(), TZ, NOW);
    expect(s.mins).toBe(15);
    expect(s.arriveClock).toBe("12:15 PM");
    expect(s.lateMins).toBeNull();
  });

  it("counts minutes behind schedule when the booked time is missed", () => {
    // Booked for 11:00, arriving 12:15 — 75 minutes behind.
    const s = etaSummary(
      leg({
        scheduledFor: new Date(Date.UTC(2026, 7, 9, 17, 0, 0)).toISOString(),
      }),
      TZ,
      NOW,
    );
    expect(s.lateMins).toBe(75);
  });

  it("gives a five-minute grace before calling anyone late", () => {
    // Booked for 12:12, arriving 12:15 — three minutes is traffic, not late.
    const s = etaSummary(
      leg({
        scheduledFor: new Date(Date.UTC(2026, 7, 9, 18, 12, 0)).toISOString(),
      }),
      TZ,
      NOW,
    );
    expect(s.lateMins).toBeNull();
  });

  it("never says 0 min away", () => {
    const s = etaSummary(leg({ etaSeconds: 20 }), TZ, NOW);
    expect(s.mins).toBe(1);
  });

  it("labels the chip, marking estimates as such", () => {
    expect(chipLabel(leg(), TZ, NOW)).toBe("15 min · 12:15 PM");
    expect(chipLabel(leg({ source: "estimate" }), TZ, NOW)).toBe(
      "15 min · 12:15 PM (est.)",
    );
  });

  it("writes the full heading sentence", () => {
    expect(headingLabel(leg(), TZ, NOW)).toBe(
      "Heading to Sarah M. · 15 min away · arrives 12:15 PM · on time",
    );
  });
});
