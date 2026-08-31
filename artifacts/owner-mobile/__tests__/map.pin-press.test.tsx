// @vitest-environment jsdom
/**
 * Jumping from a map pin to the booking: tapping a job pin's callout must
 * hand back that pin's booking id (and only job pins do this — cleaner dots,
 * destination dots and ETA chips never navigate).
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { MapJob, MapRouteLeg } from "@/lib/routeTrails";

// Stub react-native-maps (no web renderer): Marker records the callout-press
// handlers it was given so the test can fire them like a tap.
const calloutHandlers: Array<{
  title?: string;
  onCalloutPress?: () => void;
}> = [];
vi.mock("react-native-maps", () => {
  const MapView = React.forwardRef(function MapView(
    { children }: { children?: React.ReactNode },
    _ref: React.Ref<unknown>,
  ) {
    return <>{children}</>;
  });
  return {
    default: MapView,
    Marker: ({
      children,
      title,
      onCalloutPress,
    }: {
      children?: React.ReactNode;
      title?: string;
      onCalloutPress?: () => void;
    }) => {
      calloutHandlers.push({ title, onCalloutPress });
      return <>{children}</>;
    },
    Polyline: () => null,
  };
});

import { TrailMap } from "@/components/TrailMap";

const TZ = "America/Edmonton";

function job(bookingId: number, customerName: string): MapJob {
  return {
    bookingId,
    customerName,
    customerAddress: "99 Birch Ave",
    lat: 53.8,
    lng: -113.3,
    scheduledFor: new Date(Date.UTC(2026, 7, 9, 21, 0, 0)).toISOString(),
    status: "confirmed",
    assignees: [],
  };
}

function leg(): MapRouteLeg {
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
  };
}

afterEach(() => {
  cleanup();
  calloutHandlers.length = 0;
});

describe("job pin callout → booking details", () => {
  it("tapping a job pin's callout reports that pin's booking id", () => {
    const onJobPress = vi.fn();
    render(
      <TrailMap
        routes={[leg()]}
        jobs={[job(9, "Priya K."), job(14, "Omar D.")]}
        framingReady={true}
        timezone={TZ}
        nowMs={Date.UTC(2026, 7, 9, 18, 0, 0)}
        onJobPress={onJobPress}
      />,
    );

    const priya = calloutHandlers.find((h) => h.title === "Priya K.");
    const omar = calloutHandlers.find((h) => h.title === "Omar D.");
    expect(priya?.onCalloutPress).toBeTypeOf("function");
    expect(omar?.onCalloutPress).toBeTypeOf("function");

    omar!.onCalloutPress!();
    expect(onJobPress).toHaveBeenCalledTimes(1);
    expect(onJobPress).toHaveBeenCalledWith(14);
  });

  it("only job pins navigate — trail markers get no callout-press handler", () => {
    const onJobPress = vi.fn();
    render(
      <TrailMap
        routes={[leg()]}
        jobs={[job(9, "Priya K.")]}
        framingReady={true}
        timezone={TZ}
        nowMs={Date.UTC(2026, 7, 9, 18, 0, 0)}
        onJobPress={onJobPress}
      />,
    );

    for (const h of calloutHandlers) {
      if (h.title === "Priya K.") continue;
      expect(h.onCalloutPress).toBeUndefined();
    }
  });
});
