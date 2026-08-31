import { haversineKm, type Coords } from "./nearest";

/**
 * How far from the middle of the pack a point can sit and still be framed.
 *
 * Roughly the radius of a day's driving around a city. Anything past it is
 * either a mis-geocoded address (a street name that also exists two provinces
 * over) or a genuinely out-of-town one-off — and either way, letting it decide
 * the zoom level means the city everyone actually works in shrinks to a smudge.
 */
export const FRAME_RADIUS_KM = 120;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Which of the plotted points the map should frame itself around.
 *
 * The middle is taken as a median rather than an average precisely because one
 * bad point should not drag it: with nine addresses in Edmonton and one in
 * Texas, the median is still firmly in Edmonton, so the Texas one falls outside
 * the radius and is left out of the framing. Every point is still *drawn* —
 * this only decides what the opening view is built around, and the dispatcher
 * can always zoom out to go looking.
 *
 * If everything is spread out (a company working two cities, say), nothing is
 * dropped: the fallback is to frame the lot.
 */
export function pointsToFrame<T extends Coords>(points: T[]): T[] {
  if (points.length < 3) return points;

  const middle = {
    lat: median(points.map((p) => p.lat)),
    lng: median(points.map((p) => p.lng)),
  };
  const near = points.filter((p) => haversineKm(middle, p) <= FRAME_RADIUS_KM);
  return near.length > 0 ? near : points;
}
