import { describe, expect, it } from "vitest";
import {
  colorForTeamMember,
  midpointOf,
  clockInZone,
  etaSummary,
  chipLabel,
  headingLabel,
  jobPinLabel,
  jobPinCrew,
  jobPinDescription,
  regionForTrails,
  type MapJob,
  type MapRouteLeg,
} from "./routeTrails";

// Noon MDT on the test day — same fixtures as the web dashboard's suite, so
// a drift between the two copies shows up as a failing test on either side.
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

describe("colorForTeamMember", () => {
  it("uses the roster colour when it's a valid hex", () => {
    expect(colorForTeamMember(7, " #A1B2C3 ")).toBe("#a1b2c3");
  });

  it("derives a stable hue when no colour is chosen", () => {
    expect(colorForTeamMember(7, null)).toBe(colorForTeamMember(7));
    expect(colorForTeamMember(7)).not.toBe(colorForTeamMember(8));
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

describe("regionForTrails", () => {
  it("returns null with nothing to frame", () => {
    expect(regionForTrails([])).toBeNull();
  });

  it("frames every trail's path and destination with padding", () => {
    const region = regionForTrails([leg()]);
    expect(region).not.toBeNull();
    expect(region!.latitude).toBeCloseTo(53.55, 5);
    expect(region!.longitude).toBeCloseTo(-113.5, 5);
    // 0.02 lat span * 1.4 padding = 0.028.
    expect(region!.latitudeDelta).toBeCloseTo(0.028, 5);
    expect(region!.longitudeDelta).toBeCloseTo(0.028, 5);
  });

  it("never zooms tighter than the floor for a short hop", () => {
    const region = regionForTrails([
      leg({
        path: [
          { lat: 53.5, lng: -113.5 },
          { lat: 53.5001, lng: -113.5001 },
        ],
        destLat: 53.5001,
        destLng: -113.5001,
      }),
    ]);
    expect(region!.latitudeDelta).toBe(0.02);
    expect(region!.longitudeDelta).toBe(0.02);
  });

  it("frames job pins even when there are no trails", () => {
    const region = regionForTrails(
      [],
      [
        { lat: 53.5, lng: -113.5 },
        { lat: 53.6, lng: -113.4 },
      ],
    );
    expect(region).not.toBeNull();
    expect(region!.latitude).toBeCloseTo(53.55, 5);
    expect(region!.longitude).toBeCloseTo(-113.45, 5);
  });

  it("widens the frame to include job pins outside the trails", () => {
    const region = regionForTrails([leg()], [{ lat: 53.7, lng: -113.6 }]);
    // Without the pin the lat span is 0.02; with it, 0.16 * 1.4 padding.
    expect(region!.latitudeDelta).toBeCloseTo(0.16 * 1.4, 5);
  });

  it("ignores invalid coordinates instead of handing native maps a bad region", () => {
    const region = regionForTrails(
      [
        leg({
          path: [
            { lat: Number.NaN, lng: -113.5 },
            { lat: 53.5, lng: -113.5 },
          ],
          destLat: Number.POSITIVE_INFINITY,
        }),
      ],
      [{ lat: 53.6, lng: -113.4 }],
    );
    expect(region).not.toBeNull();
    expect(region!.latitude).toBeCloseTo(53.55, 5);
    expect(Number.isFinite(region!.latitudeDelta)).toBe(true);
    expect(Number.isFinite(region!.longitudeDelta)).toBe(true);
  });
});

describe("jobPinLabel", () => {
  const job = (over: Partial<MapJob> = {}): MapJob => ({
    bookingId: 9,
    customerName: "Sarah M.",
    customerAddress: "12 Oak St",
    lat: 53.56,
    lng: -113.51,
    scheduledFor: new Date(Date.UTC(2026, 7, 9, 20, 30, 0)).toISOString(),
    status: "confirmed",
    assignees: [],
    ...over,
  });

  it("shows the scheduled time in the company timezone, not the device's", () => {
    expect(jobPinLabel(job(), TZ)).toBe("Scheduled 2:30 PM");
  });

  it("says so plainly when the timestamp is unreadable", () => {
    expect(jobPinLabel(job({ scheduledFor: "garbage" }), TZ)).toBe(
      "Scheduled time unknown",
    );
  });
});

describe("job pin crew", () => {
  const job = (over: Partial<MapJob> = {}): MapJob => ({
    bookingId: 9,
    customerName: "Sarah M.",
    customerAddress: "12 Oak St",
    lat: 53.56,
    lng: -113.51,
    scheduledFor: new Date(Date.UTC(2026, 7, 9, 20, 30, 0)).toISOString(),
    status: "confirmed",
    assignees: [],
    ...over,
  });
  const crew = (...names: string[]) =>
    names.map((name, i) => ({ teamMemberId: i + 1, name, color: null }));

  it("names the assigned cleaners, comma-joined", () => {
    expect(jobPinCrew(job({ assignees: crew("Alex", "Sam") }))).toBe(
      "Alex, Sam",
    );
  });

  it("is null when nobody is assigned (or names are blank)", () => {
    expect(jobPinCrew(job())).toBeNull();
    expect(jobPinCrew(job({ assignees: crew("  ") }))).toBeNull();
  });

  it("puts the hour first, then who's on the job", () => {
    expect(jobPinDescription(job({ assignees: crew("Alex") }), TZ)).toBe(
      "Scheduled 2:30 PM · Alex",
    );
  });

  it("falls back to just the hour with no crew", () => {
    expect(jobPinDescription(job(), TZ)).toBe("Scheduled 2:30 PM");
  });
});
