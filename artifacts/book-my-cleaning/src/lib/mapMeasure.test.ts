/**
 * The measure tool.
 *
 * Two promises are pinned here:
 *
 *  - the number it shows is the SAME number the Closest Crew card shows for
 *    the same two points. Both go through `haversineKm` + `formatKm` +
 *    `formatDriveMinutes`, and this file compares them directly so a future
 *    "let's round differently in the readout" can't split them;
 *  - only one map tool can be armed at a time, by construction. Drop, move
 *    and measure are one field, and every transition below proves that
 *    turning one on puts the others away — including the measurement itself,
 *    which never survives a mode change.
 */
import { describe, expect, it } from "vitest";
import {
  IDLE_TOOLS,
  addMeasurePoint,
  cancelTool,
  clearMeasurement,
  measureBetween,
  measurementOf,
  measurePointLabel,
  setMeasurementPoints,
  startMovingPin,
  toggleDropMode,
  toggleMeasureMode,
  type MapToolState,
} from "./mapMeasure";
import {
  formatDriveMinutes,
  formatKm,
  haversineKm,
  nearestCleaners,
} from "./nearest";

const DOWNTOWN = { lat: 53.5461, lng: -113.4938, label: "Sarah M." };
const SOUTHSIDE = { lat: 53.4668, lng: -113.5231, label: null };

/** Arm measure and drop the points in, the way clicks would. */
function measuring(
  ...points: Array<{ lat: number; lng: number; label?: string | null }>
) {
  let state: MapToolState = toggleMeasureMode(IDLE_TOOLS);
  for (const p of points) {
    state = addMeasurePoint(state, {
      lat: p.lat,
      lng: p.lng,
      label: p.label ?? null,
    });
  }
  return state;
}

describe("measureBetween", () => {
  it("formats the straight-line distance and a drive estimate", () => {
    const m = measureBetween(DOWNTOWN, SOUTHSIDE);
    expect(m.km).toBeCloseTo(haversineKm(DOWNTOWN, SOUTHSIDE), 10);
    expect(m.distance).toBe(formatKm(m.km));
    expect(m.drive).toBe(formatDriveMinutes(m.km));
    // Roughly 9 km apart across Edmonton — a sanity check on the maths, not
    // just on the plumbing.
    expect(m.km).toBeGreaterThan(8);
    expect(m.km).toBeLessThan(10);
  });

  it("reads the same as the Closest Crew card for the same two points", () => {
    // The card ranks a cleaner's HOME against a job; measuring between the
    // same two spots must produce the identical strings.
    const ranked = nearestCleaners(DOWNTOWN, {
      staffHomes: [
        {
          teamMemberId: 1,
          name: "Casey",
          color: null,
          roleLabel: "Cleaner",
          address: "1 Southside Rd",
          lat: SOUTHSIDE.lat,
          lng: SOUTHSIDE.lng,
          active: true,
        },
      ],
    } as any);
    const row = ranked[0]!;
    const measured = measureBetween(DOWNTOWN, SOUTHSIDE);
    expect(measured.distance).toBe(formatKm(row.km));
    expect(measured.drive).toBe(formatDriveMinutes(row.km));
  });

  it("says metres up close and whole kilometres far away, like the rest of the map", () => {
    const nextDoor = measureBetween(DOWNTOWN, {
      lat: DOWNTOWN.lat + 0.0015,
      lng: DOWNTOWN.lng,
    });
    expect(nextDoor.distance).toMatch(/ m$/);
    // Even next door is never "0 min" — parking and pulling out cost time.
    expect(nextDoor.drive).toBe("~5 min");

    const acrossTheProvince = measureBetween(DOWNTOWN, {
      lat: 51.0447,
      lng: -114.0719,
    });
    expect(acrossTheProvince.distance).toMatch(/^\d+ km$/);
    expect(acrossTheProvince.drive).toMatch(/^~\d+ h/);
  });
});

describe("measurePointLabel", () => {
  it("uses the name of whatever was clicked", () => {
    expect(measurePointLabel(DOWNTOWN, "Point A")).toBe("Sarah M.");
  });

  it("falls back for bare map clicks and blank names", () => {
    expect(measurePointLabel(SOUTHSIDE, "Point B")).toBe("Point B");
    expect(measurePointLabel({ ...SOUTHSIDE, label: "  " }, "Point B")).toBe(
      "Point B",
    );
    expect(measurePointLabel(null, "Point A")).toBe("Point A");
  });
});

describe("measure mode transitions", () => {
  it("goes start → first point → second point → fresh start", () => {
    const armed = toggleMeasureMode(IDLE_TOOLS);
    expect(armed.tool).toBe("measure");
    expect(measurementOf(armed)).toBeNull();

    const first = addMeasurePoint(armed, DOWNTOWN);
    expect(first.start).toEqual(DOWNTOWN);
    expect(first.end).toBeNull();
    // One point is not a measurement — nothing is shown yet.
    expect(measurementOf(first)).toBeNull();

    const second = addMeasurePoint(first, SOUTHSIDE);
    expect(second.end).toEqual(SOUTHSIDE);
    const done = measurementOf(second)!;
    expect(done.distance).toBe(measureBetween(DOWNTOWN, SOUTHSIDE).distance);

    // A third click restarts rather than extending into a path.
    const third = addMeasurePoint(second, {
      lat: 53.6,
      lng: -113.3,
      label: null,
    });
    expect(third.start).toEqual({ lat: 53.6, lng: -113.3, label: null });
    expect(third.end).toBeNull();
    expect(third.tool).toBe("measure");
    expect(measurementOf(third)).toBeNull();
  });

  it("keeps the label of whatever was clicked on the map", () => {
    const state = measuring(DOWNTOWN, { ...SOUTHSIDE, label: "Casey (home)" });
    expect(state.start!.label).toBe("Sarah M.");
    expect(state.end!.label).toBe("Casey (home)");
  });

  it("opens a complete comparison chosen from a distance result", () => {
    const compared = setMeasurementPoints(DOWNTOWN, {
      ...SOUTHSIDE,
      label: "123 Test Ave",
    });
    expect(compared.tool).toBe("measure");
    expect(compared.start).toEqual(DOWNTOWN);
    expect(compared.end?.label).toBe("123 Test Ave");
    expect(measurementOf(compared)?.distance).toBe(
      measureBetween(DOWNTOWN, SOUTHSIDE).distance,
    );
  });

  it("wipes the measurement and the mode on Escape or Clear", () => {
    const measured = measuring(DOWNTOWN, SOUTHSIDE);
    for (const back of [cancelTool(measured), clearMeasurement(measured)]) {
      expect(back).toEqual(IDLE_TOOLS);
      expect(measurementOf(back)).toBeNull();
    }
  });

  it("puts the tool away — and the measurement with it — when toggled off", () => {
    const off = toggleMeasureMode(measuring(DOWNTOWN, SOUTHSIDE));
    expect(off).toEqual(IDLE_TOOLS);
  });

  it("ignores points when measure isn't the armed tool", () => {
    const dropping = toggleDropMode(IDLE_TOOLS);
    expect(addMeasurePoint(dropping, DOWNTOWN)).toEqual(dropping);
    expect(addMeasurePoint(IDLE_TOOLS, DOWNTOWN)).toEqual(IDLE_TOOLS);
  });
});

describe("the three tools never fight", () => {
  it("drops the measurement when drop-pin mode is armed", () => {
    const next = toggleDropMode(measuring(DOWNTOWN, SOUTHSIDE));
    expect(next.tool).toBe("drop");
    expect(next.start).toBeNull();
    expect(next.end).toBeNull();
  });

  it("drops the measurement when a pin move starts", () => {
    const next = startMovingPin(measuring(DOWNTOWN, SOUTHSIDE), {
      id: 4,
      name: "Back lane",
    });
    expect(next.tool).toBe("move");
    expect(next.movingPin).toEqual({ id: 4, name: "Back lane" });
    expect(next.start).toBeNull();
  });

  it("disarms drop and move when measuring starts", () => {
    const fromDrop = toggleMeasureMode(toggleDropMode(IDLE_TOOLS));
    expect(fromDrop.tool).toBe("measure");

    const fromMove = toggleMeasureMode(
      startMovingPin(IDLE_TOOLS, { id: 1, name: "Gate" }),
    );
    expect(fromMove.tool).toBe("measure");
    // No half-finished move left behind to swallow the next click.
    expect(fromMove.movingPin).toBeNull();
  });

  it("never has two tools armed, whatever order they're used in", () => {
    const states: MapToolState[] = [
      IDLE_TOOLS,
      toggleDropMode(IDLE_TOOLS),
      toggleMeasureMode(toggleDropMode(IDLE_TOOLS)),
      startMovingPin(toggleMeasureMode(IDLE_TOOLS), { id: 2, name: "Shed" }),
      toggleDropMode(startMovingPin(IDLE_TOOLS, { id: 2, name: "Shed" })),
      addMeasurePoint(toggleMeasureMode(IDLE_TOOLS), DOWNTOWN),
    ];
    for (const s of states) {
      expect(["none", "drop", "move", "measure"]).toContain(s.tool);
      // The move pin only exists for the move tool; measured points only for
      // the measure tool.
      if (s.tool !== "move") expect(s.movingPin).toBeNull();
      if (s.tool !== "measure") expect(s.start).toBeNull();
    }
  });
});
