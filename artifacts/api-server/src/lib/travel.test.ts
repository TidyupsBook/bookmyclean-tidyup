import { describe, it, expect } from "vitest";
import { haversineKm, estimateDriveMinutes, travelLegsForLane } from "./travel";

// Two real Edmonton points roughly 10 km apart, so the numbers are checkable.
const HOME = { lat: 53.5461, lng: -113.4938 }; // downtown
const JOB_1 = { lat: 53.5225, lng: -113.6242 }; // west end
const JOB_2 = { lat: 53.4522, lng: -113.4696 }; // south side

describe("travel legs", () => {
  it("measures home → first job, then job → job", () => {
    const legs = travelLegsForLane(
      [
        { ...JOB_1, label: "Anna West" },
        { ...JOB_2, label: "Bob South" },
      ],
      HOME,
    );
    expect(legs).toHaveLength(2);
    expect(legs[0]!.fromHome).toBe(true);
    expect(legs[0]!.fromLabel).toBe("home");
    expect(legs[0]!.distanceKm).toBeCloseTo(haversineKm(HOME, JOB_1), 0);
    expect(legs[1]!.fromHome).toBe(false);
    expect(legs[1]!.fromLabel).toBe("Anna West");
    expect(legs[1]!.distanceKm).toBeCloseTo(haversineKm(JOB_1, JOB_2), 0);
    // Sanity: both cross-town hops are kilometres, not metres or thousands.
    expect(legs[0]!.distanceKm).toBeGreaterThan(5);
    expect(legs[0]!.distanceKm).toBeLessThan(20);
  });

  it("skips jobs without coordinates and measures from the last located stop", () => {
    const legs = travelLegsForLane(
      [
        { ...JOB_1, label: "Anna" },
        { lat: null, lng: null, label: "No address" },
        { ...JOB_2, label: "Bob" },
      ],
      HOME,
    );
    expect(legs[1]).toBeNull();
    // Third job measures from job 1, not from the unlocatable one.
    expect(legs[2]!.fromLabel).toBe("Anna");
  });

  it("gives the first job no leg when the cleaner has no geocoded home", () => {
    const legs = travelLegsForLane(
      [
        { ...JOB_1, label: "Anna" },
        { ...JOB_2, label: "Bob" },
      ],
      null,
    );
    expect(legs[0]).toBeNull();
    // But the second job still measures from the first.
    expect(legs[1]!.fromLabel).toBe("Anna");
  });

  it("drive estimate scales with distance and never reads as zero", () => {
    expect(estimateDriveMinutes(0.1)).toBe(5);
    const tenKm = estimateDriveMinutes(10);
    expect(tenKm).toBeGreaterThanOrEqual(15);
    expect(tenKm).toBeLessThanOrEqual(25);
  });
});
