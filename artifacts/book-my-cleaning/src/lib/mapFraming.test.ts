import { describe, expect, it } from "vitest";
import { pointsToFrame } from "./mapFraming";

const EDMONTON = { lat: 53.5461, lng: -113.4938 };
const ST_ALBERT = { lat: 53.6305, lng: -113.6256 };
const SHERWOOD_PARK = { lat: 53.5169, lng: -113.3186 };
const LEDUC = { lat: 53.2594, lng: -113.5492 };
const TEXAS = { lat: 32.7767, lng: -96.797 };

describe("pointsToFrame", () => {
  it("keeps everything inside the service area", () => {
    const points = [EDMONTON, ST_ALBERT, SHERWOOD_PARK, LEDUC];
    expect(pointsToFrame(points)).toEqual(points);
  });

  it("leaves one far-flung address out of the framing", () => {
    // The whole point: a single mis-geocoded address must not zoom the map out
    // to half a continent and shrink the city to a smudge.
    const framed = pointsToFrame([EDMONTON, ST_ALBERT, SHERWOOD_PARK, TEXAS]);
    expect(framed).not.toContain(TEXAS);
    expect(framed).toHaveLength(3);
  });

  it("frames everything when the work really is spread out", () => {
    // Two distant clusters are a company working two cities, not a mistake —
    // hiding half of them from the opening view would be the wrong call.
    const calgary = { lat: 51.0447, lng: -114.0719 };
    const points = [EDMONTON, ST_ALBERT, calgary, { ...calgary, lat: 51.05 }];
    expect(pointsToFrame(points)).toEqual(points);
  });

  it("never drops anything when there are only a couple of points", () => {
    // With one or two pins there is no "middle of the pack" to be an outlier
    // from, and dropping either would frame the map on nothing.
    expect(pointsToFrame([EDMONTON, TEXAS])).toEqual([EDMONTON, TEXAS]);
    expect(pointsToFrame([TEXAS])).toEqual([TEXAS]);
    expect(pointsToFrame([])).toEqual([]);
  });
});
