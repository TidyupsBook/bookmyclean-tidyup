// @vitest-environment jsdom
/**
 * The role gate on the map's lateness nudge: dispatch gets one toast per
 * slip and an amber roster set, a cleaner gets neither — including when the
 * resolved role *changes* under a mounted page (account switch, refetch).
 * These tests pin that a dispatch→cleaner transition clears the highlight
 * and that no toast ever fires for a non-dispatch viewer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useLateAlerts } from "./useLateAlerts";
import type { MapRouteLeg } from "./routeTrails";

const NOW_TZ = "America/Edmonton";

function lateLeg(over: Partial<MapRouteLeg> = {}): MapRouteLeg {
  return {
    teamMemberId: 7,
    name: "Casey Cleaner",
    color: null,
    bookingId: 42,
    customerName: "Sarah M.",
    customerAddress: "12 Oak St",
    destLat: 53.56,
    destLng: -113.51,
    // Booked an hour ago, still 15 minutes out — unambiguously late.
    scheduledFor: new Date(Date.now() - 60 * 60_000).toISOString(),
    etaSeconds: 15 * 60,
    distanceMeters: 8400,
    source: "google",
    path: [
      { lat: 53.54, lng: -113.49 },
      { lat: 53.56, lng: -113.51 },
    ],
    ...over,
  };
}

/** Mount the hook bare; expose its returned set through a callback. */
function Harness({
  routes,
  isDispatch,
  notify,
  onLate,
}: {
  routes: MapRouteLeg[];
  isDispatch: boolean;
  notify: (msg: { title: string; description: string }) => void;
  onLate: (late: Set<number>) => void;
}) {
  const late = useLateAlerts(routes, NOW_TZ, isDispatch, notify);
  onLate(late);
  return null;
}

afterEach(cleanup);

describe("useLateAlerts role gate", () => {
  it("never notifies a non-dispatch viewer", () => {
    const notify = vi.fn();
    let late: Set<number> = new Set([999]);
    render(
      <Harness
        routes={[lateLeg()]}
        isDispatch={false}
        notify={notify}
        onLate={(s) => (late = s)}
      />,
    );
    expect(notify).not.toHaveBeenCalled();
    expect(late.size).toBe(0);
  });

  it("clears the late highlight and alert history when dispatch becomes a cleaner", () => {
    const notify = vi.fn();
    let late: Set<number> = new Set();
    const routes = [lateLeg()];
    const { rerender } = render(
      <Harness
        routes={routes}
        isDispatch={true}
        notify={notify}
        onLate={(s) => (late = s)}
      />,
    );
    // Dispatch saw the slip: one toast, chip highlighted.
    expect(notify).toHaveBeenCalledTimes(1);
    expect([...late]).toEqual([7]);

    // The signed-in role resolves to a cleaner without an unmount.
    rerender(
      <Harness
        routes={routes}
        isDispatch={false}
        notify={notify}
        onLate={(s) => (late = s)}
      />,
    );
    expect(late.size).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);

    // Back to dispatch (say, the refetch was a blip): the state machine
    // restarted from scratch, so the still-late trail is announced anew
    // rather than half-remembered.
    rerender(
      <Harness
        routes={routes}
        isDispatch={true}
        notify={notify}
        onLate={(s) => (late = s)}
      />,
    );
    expect([...late]).toEqual([7]);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("does not repeat the toast while the same routes stay late", () => {
    const notify = vi.fn();
    const routes = [lateLeg()];
    const { rerender } = render(
      <Harness
        routes={routes}
        isDispatch={true}
        notify={notify}
        onLate={() => {}}
      />,
    );
    // Next poll returns a fresh array with the same still-late trail.
    rerender(
      <Harness
        routes={[lateLeg()]}
        isDispatch={true}
        notify={notify}
        onLate={() => {}}
      />,
    );
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
