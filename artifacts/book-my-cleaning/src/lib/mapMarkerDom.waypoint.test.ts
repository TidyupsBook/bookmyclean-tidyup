// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { pinMarker, waypointMarker } from "./mapMarkerDom";

describe("dispatcher waypoint marker", () => {
  it("uses a flag silhouette instead of the client teardrop", () => {
    const waypoint = waypointMarker("hsl(24,90%,50%)", "S2");
    const clientPin = pinMarker("hsl(330,81%,55%)");

    expect(waypoint.dataset.markerKind).toBe("waypoint");
    expect(waypoint.textContent).toBe("S2");
    expect(waypoint.style.cssText).not.toBe(clientPin.style.cssText);
    expect(waypoint.children).toHaveLength(3);
  });
});
