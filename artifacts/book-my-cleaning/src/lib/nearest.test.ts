import { describe, expect, it } from "vitest";
import {
  estimateDriveMinutes,
  formatDriveMinutes,
  formatKm,
  haversineKm,
  nearestCleaners,
} from "./nearest";
import { selectMapMarkers } from "./mapMarkerSelection";

const EDMONTON = { lat: 53.5461, lng: -113.4938 };
const NOW = Date.parse("2026-08-07T12:00:00Z");
const fresh = new Date(NOW - 60 * 1000).toISOString();
const stale = new Date(NOW - 60 * 60 * 1000).toISOString();

function home(
  teamMemberId: number,
  name: string,
  lat: number,
  lng: number,
  active = true,
) {
  return {
    teamMemberId,
    name,
    color: null,
    roleLabel: "Cleaner",
    address: `${name} street`,
    lat,
    lng,
    active,
  };
}

describe("haversineKm", () => {
  it("is zero for the same point", () => {
    expect(haversineKm(EDMONTON, EDMONTON)).toBe(0);
  });

  it("measures a known distance", () => {
    // Edmonton to Calgary is about 280 km in a straight line.
    const calgary = { lat: 51.0447, lng: -114.0719 };
    expect(haversineKm(EDMONTON, calgary)).toBeGreaterThan(270);
    expect(haversineKm(EDMONTON, calgary)).toBeLessThan(290);
  });

  it("does not treat a degree of longitude as a degree of latitude", () => {
    // The cheap flat approximation gets this wrong: this far north a degree of
    // longitude is a bit over half the ground distance of a degree of latitude,
    // and a ranking built on the naive version reorders the crew.
    const north = { lat: EDMONTON.lat + 1, lng: EDMONTON.lng };
    const east = { lat: EDMONTON.lat, lng: EDMONTON.lng + 1 };
    expect(haversineKm(EDMONTON, east)).toBeLessThan(
      haversineKm(EDMONTON, north),
    );
  });
});

describe("nearestCleaners", () => {
  it("ranks staff homes by distance from the job", () => {
    const near = home(1, "Near", 53.55, -113.5);
    const far = home(2, "Far", 53.7, -113.9);

    const ranked = nearestCleaners(EDMONTON, { staffHomes: [far, near] }, NOW);

    expect(ranked.map((r) => r.name)).toEqual(["Near", "Far"]);
    expect(ranked[0]!.source).toBe("home");
    expect(ranked[0]!.km).toBeLessThan(ranked[1]!.km);
  });

  it("prefers a live position over the home address", () => {
    // Lives across the city but is parked around the corner right now — the
    // whole point of asking during the working day.
    const staffHomes = [home(1, "Ann", 53.7, -113.9)];
    const cleaners = [
      {
        teamMemberId: 1,
        name: "Ann",
        color: null,
        lat: 53.547,
        lng: -113.494,
        accuracy: 10,
        updatedAt: fresh,
      },
    ];

    const ranked = nearestCleaners(EDMONTON, { cleaners, staffHomes }, NOW);

    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.source).toBe("live");
    expect(ranked[0]!.km).toBeLessThan(1);
    // The card's address still rides along, so the panel can show it.
    expect(ranked[0]!.address).toBe("Ann street");
  });

  it("falls back to the home address when a phone has gone quiet", () => {
    const staffHomes = [home(1, "Ann", 53.7, -113.9)];
    const cleaners = [
      {
        teamMemberId: 1,
        name: "Ann",
        color: null,
        lat: 53.547,
        lng: -113.494,
        accuracy: 10,
        updatedAt: stale,
      },
    ];

    const ranked = nearestCleaners(EDMONTON, { cleaners, staffHomes }, NOW);

    expect(ranked[0]!.source).toBe("home");
    expect(ranked[0]!.km).toBeGreaterThan(20);
  });

  it("lists one row per person, never a home and a live pin both", () => {
    const staffHomes = [
      home(1, "Ann", 53.7, -113.9),
      home(2, "Bo", 53.6, -113.6),
    ];
    const cleaners = [
      {
        teamMemberId: 1,
        name: "Ann",
        color: null,
        lat: 53.55,
        lng: -113.5,
        accuracy: null,
        updatedAt: fresh,
      },
    ];

    const ranked = nearestCleaners(EDMONTON, { cleaners, staffHomes }, NOW);

    expect(ranked).toHaveLength(2);
    expect(ranked.filter((r) => r.teamMemberId === 1)).toHaveLength(1);
  });

  it("ranks someone off the roster on distance like everyone else", () => {
    // The question is "who is closest", full stop. Hiding an off-roster
    // cleaner, or burying them under someone twenty kilometres away, makes the
    // list answer a different question than the one the office asked.
    const offRoster = home(1, "Off", 53.5462, -113.4939, false);
    const working = home(2, "On", 53.7, -113.9);

    const ranked = nearestCleaners(
      EDMONTON,
      { staffHomes: [offRoster, working] },
      NOW,
    );

    expect(ranked.map((r) => r.name)).toEqual(["Off", "On"]);
    expect(ranked[0]!.active).toBe(false);
  });

  it("skips anyone without usable coordinates", () => {
    const ranked = nearestCleaners(
      EDMONTON,
      {
        staffHomes: [
          home(1, "Placed", 53.55, -113.5),
          // 0,0 is the classic "never geocoded" row; it would otherwise show up
          // as a cleaner living in the Atlantic.
          home(2, "Unplaced", 0, 0),
        ],
      },
      NOW,
    );

    expect(ranked.map((r) => r.name)).toEqual(["Placed"]);
  });

  it("returns nothing when the company has no located crew", () => {
    expect(nearestCleaners(EDMONTON, {}, NOW)).toEqual([]);
  });

  it("nearest-crew rankings ignore the roster-strip hide list", () => {
    // This test pins the deliberate split between two functions:
    //
    //   selectMapMarkers  — respects hiddenCleaners (display choice)
    //   nearestCleaners   — ignores hiddenCleaners (geographic truth)
    //
    // Both receive the same raw mapData. The hide list removes only the
    // cleaner's live car while leaving their home and distance ranking.
    // If a future change passes hiddenCleaners into nearestCleaners, or
    // pre-filters mapData before the nearestCleaners call, the assertion on
    // ranked length below will fail immediately.
    const nearHidden = home(1, "Hidden", 53.5462, -113.4939); // right next to Edmonton
    const farVisible = home(2, "Visible", 53.7, -113.9); // across the city

    const mapData = { staffHomes: [nearHidden, farVisible] };
    const hiddenCleaners = new Set([1]); // cleaner 1 is toggled off the roster strip

    // selectMapMarkers respects the hide list for live cars, but homes are
    // permanent planning references and stay drawn.
    const visible = selectMapMarkers(mapData, hiddenCleaners, new Set());
    expect(visible.staffHomes.map((s) => s.name)).toEqual([
      "Hidden",
      "Visible",
    ]);
    expect(visible.staffHomes).toHaveLength(2);

    // nearestCleaners DOES NOT respect the hide list — it reads raw mapData,
    // so the hidden-but-nearest cleaner still leads the ranking.
    // This matches the confirmed owner decision: hiding is a display preference,
    // not an availability filter; distances must never lie.
    const ranked = nearestCleaners(EDMONTON, mapData, NOW);
    expect(ranked.map((r) => r.name)).toEqual(["Hidden", "Visible"]);
    expect(ranked).toHaveLength(2);
  });
});

describe("formatKm", () => {
  it("uses metres under a kilometre", () => {
    expect(formatKm(0.42)).toBe("420 m");
  });

  it("uses one decimal in the single kilometres", () => {
    expect(formatKm(3.46)).toBe("3.5 km");
  });

  it("rounds to whole kilometres once it stops mattering", () => {
    expect(formatKm(12.37)).toBe("12 km");
  });
});

describe("estimateDriveMinutes", () => {
  it("mirrors the server's schedule estimate exactly (×1.3 roads, 40 km/h)", () => {
    // 10 km straight → 13 road km → 19.5 min → rounds to 20. If this drifts
    // from api-server's travel.ts, the map and the schedule disagree about
    // the same leg.
    expect(estimateDriveMinutes(10)).toBe(20);
  });

  it("floors at five minutes — even next door costs parking", () => {
    expect(estimateDriveMinutes(0)).toBe(5);
    expect(estimateDriveMinutes(1)).toBe(5);
  });
});

describe("formatDriveMinutes", () => {
  it("reads as an estimate", () => {
    expect(formatDriveMinutes(10)).toBe("~20 min");
  });

  it("switches to hours for long hauls", () => {
    // 100 km straight → 130 road km → 195 min.
    expect(formatDriveMinutes(100)).toBe("~3 h 15 min");
  });

  it("shows a dash when the distance is unknowable", () => {
    expect(formatDriveMinutes(Number.NaN)).toBe("—");
  });
});
