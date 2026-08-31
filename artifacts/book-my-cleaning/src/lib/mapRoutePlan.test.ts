import { describe, expect, it } from "vitest";
import {
  moveRouteStop,
  routePlanLegs,
  routePlanTotalKm,
  type RoutePlanStop,
} from "./mapRoutePlan";

const cleaner = { lat: 53.5461, lng: -113.4938, label: "Ann (live)" };
const stops: RoutePlanStop[] = [
  {
    id: 12,
    position: 2,
    name: "Second stop",
    label: "Second stop",
    lat: 53.5,
    lng: -113.6,
  },
  {
    id: 11,
    position: 1,
    name: "First stop",
    label: "First stop",
    lat: 53.54,
    lng: -113.5,
  },
];

describe("saved route planning", () => {
  it("measures from the cleaner through stops in saved order", () => {
    const legs = routePlanLegs(cleaner, stops);
    expect(legs.map((leg) => leg.stopId)).toEqual([11, 12]);
    expect(legs[0]!.from.label).toBe("Ann (live)");
    expect(legs[0]!.to.name).toBe("First stop");
    expect(legs[1]!.from.label).toBe("First stop");
    expect(routePlanTotalKm(legs)).toBeCloseTo(legs[0]!.km + legs[1]!.km, 8);
  });

  it("moves one stop while preserving a deterministic order", () => {
    expect(moveRouteStop(stops, 12, -1)).toEqual([12, 11]);
    expect(moveRouteStop(stops, 11, -1)).toEqual([11, 12]);
    expect(moveRouteStop(stops, 999, 1)).toEqual([11, 12]);
  });
});
