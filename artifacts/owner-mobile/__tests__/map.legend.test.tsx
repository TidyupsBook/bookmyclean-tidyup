// @vitest-environment jsdom
/**
 * The Map tab's shared chrome: the trail legend renders one ETA sentence per
 * live cleaner (testID trail-eta-<id>), and the frame shows the right
 * loading/empty/error copy. The ETA wording itself is unit-tested in
 * lib/routeTrails.test.ts; this guards that the screen actually renders it.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

// --- Mocks: strip Expo-native modules ---------------------------------------

vi.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

vi.mock("@/components/Brand", () => ({
  BrandHeaderTitle: ({ title }: { title: string }) => <span>{title}</span>,
  GradientRule: () => null,
}));

import { MapScreenFrame, TrailLegend } from "@/components/MapScreenShared";
import type { MapRouteLeg } from "@/lib/routeTrails";

// --- Fixtures ----------------------------------------------------------------

// Frozen clock: 2026-08-09 15:00 UTC = 11:00 AM in America/Toronto.
const NOW_MS = Date.parse("2026-08-09T15:00:00Z");
const TZ = "America/Toronto";

const onTime: MapRouteLeg = {
  teamMemberId: 1,
  name: "Alice Anders",
  color: "#3366ff",
  source: "google",
  bookingId: 101,
  etaSeconds: 600, // arrives 11:10 AM
  distanceMeters: 4200,
  scheduledFor: "2026-08-09T15:30:00Z", // booked 11:30 — on time
  customerName: "The Hendersons",
  path: [{ lat: 43.6, lng: -79.4 }],
  destLat: 43.7,
  destLng: -79.3,
};

const behind: MapRouteLeg = {
  teamMemberId: 2,
  name: "Bob Baker",
  color: null,
  source: "estimate",
  bookingId: 102,
  etaSeconds: 1200, // arrives 11:20 AM
  distanceMeters: 9800,
  scheduledFor: "2026-08-09T15:00:00Z", // booked 11:00 — 20 min behind
  customerName: "Maple Dental",
  path: [{ lat: 43.5, lng: -79.5 }],
  destLat: 43.6,
  destLng: -79.4,
};

function renderMapTab(opts: {
  routes: MapRouteLeg[];
  loading?: boolean;
  error?: boolean;
}) {
  const empty = !opts.loading && !opts.error && opts.routes.length === 0;
  return render(
    <MapScreenFrame
      insetsTop={0}
      loading={opts.loading ?? false}
      error={opts.error ?? false}
      empty={empty}
    >
      {opts.routes.length > 0 ? (
        <TrailLegend routes={opts.routes} timezone={TZ} nowMs={NOW_MS} />
      ) : null}
    </MapScreenFrame>,
  );
}

afterEach(cleanup);

// --- Legend ETA sentences -----------------------------------------------------

describe("trail legend", () => {
  it("renders each cleaner's full ETA sentence under their name", () => {
    const view = renderMapTab({ routes: [onTime, behind] });

    expect(view.getByText("Alice Anders")).toBeTruthy();
    expect(view.getByTestId("trail-eta-1").textContent).toBe(
      "Heading to The Hendersons · 10 min away · arrives 11:10 AM · on time",
    );

    expect(view.getByText("Bob Baker")).toBeTruthy();
    expect(view.getByTestId("trail-eta-2").textContent).toBe(
      "Heading to Maple Dental · 20 min away (est.) · arrives 11:20 AM · 20 min behind schedule",
    );

    // No state note competes with a populated legend.
    expect(view.queryByText(/No one is on the road/)).toBeNull();
  });
});

// --- Frame states ---------------------------------------------------------------

describe("map frame states", () => {
  it("shows the empty-state copy when there are no routes", () => {
    const view = renderMapTab({ routes: [] });
    expect(view.getByText("Map")).toBeTruthy();
    expect(
      view.getByText(
        "No one is on the road right now. Trails appear when a cleaner sharing their location has a job to head to.",
      ),
    ).toBeTruthy();
    expect(view.queryByTestId("trail-eta-1")).toBeNull();
  });

  it("shows the loading copy while the map is loading", () => {
    const view = renderMapTab({ routes: [], loading: true });
    expect(view.getByText("Loading the live map…")).toBeTruthy();
    expect(view.queryByText(/No one is on the road/)).toBeNull();
  });

  it("shows the error copy when the trails can't load", () => {
    const view = renderMapTab({ routes: [], error: true });
    expect(
      view.getByText("We couldn't load the live map. It retries on its own."),
    ).toBeTruthy();
  });
});
