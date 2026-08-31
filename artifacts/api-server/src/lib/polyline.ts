/**
 * Decoder for Google's encoded polyline format.
 *
 * Directions responses carry the drawn route as one encoded string
 * (`overview_polyline.points`). Decoding on the server keeps the browser free
 * of the Maps `geometry` library — the dashboard receives plain lat/lng
 * points it can hand straight to a Polyline.
 *
 * Reference: https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
import type { LatLng } from "./travel";

export function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    for (const axis of ["lat", "lng"] as const) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        if (index >= encoded.length) return points; // truncated input
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === "lat") lat += delta;
      else lng += delta;
    }
    points.push({ lat: lat * 1e-5, lng: lng * 1e-5 });
  }
  return points;
}
