// @vitest-environment jsdom
/**
 * The measure tool as the dispatcher (and the cleaner) actually meets it: the
 * toolbar button, the routed readout, Clear, and explicit unavailable states.
 *
 * The harness wires the real toolbar to the real transitions from
 * mapMeasure.ts, so a map click is simulated by the same call the page makes.
 * Every test runs with `fetch` stubbed and asserts it stayed untouched: a
 * measurement that quietly saved a pin would be the one bug worth catching
 * here, and it would be invisible in the UI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { MapToolbar } from "./map";
import {
  IDLE_TOOLS,
  addMeasurePoint,
  clearMeasurement,
  measurementOf,
  toggleDropMode,
  toggleMeasureMode,
  type MapToolState,
  type MeasurePoint,
} from "@/lib/mapMeasure";

const DOWNTOWN: MeasurePoint = {
  lat: 53.5461,
  lng: -113.4938,
  label: "Sarah M.",
};
const SOUTHSIDE: MeasurePoint = { lat: 53.4668, lng: -113.5231, label: null };

let fetchSpy: ReturnType<typeof vi.fn>;

/** The toolbar plus the page's own state plumbing, driven from test buttons. */
function Harness({
  canEditPins,
  routeState = "success",
}: {
  canEditPins: boolean;
  routeState?: "success" | "loading" | "error";
}) {
  const [tools, setTools] = useState<MapToolState>(IDLE_TOOLS);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <MapToolbar
        mapParams={{ all: true }}
        canEditPins={canEditPins}
        dropMode={tools.tool === "drop"}
        dropping={false}
        tools={tools}
        measurement={measurementOf(tools)}
        drivingMeasurement={
          routeState === "success" && measurementOf(tools)
            ? { distanceMeters: 12_400, durationSeconds: 1_380 }
            : undefined
        }
        drivingMeasurementLoading={routeState === "loading"}
        drivingMeasurementError={routeState === "error"}
        onToggleDropMode={() => setTools(toggleDropMode)}
        onToggleMeasure={() => setTools(toggleMeasureMode)}
        onClearMeasure={() => setTools(clearMeasurement)}
      />
      {/* Stand-ins for clicks landing on the map itself. */}
      <button
        type="button"
        data-testid="fake-map-click-a"
        onClick={() => setTools((s) => addMeasurePoint(s, DOWNTOWN))}
      />
      <button
        type="button"
        data-testid="fake-map-click-b"
        onClick={() => setTools((s) => addMeasurePoint(s, SOUTHSIDE))}
      />
    </QueryClientProvider>
  );
}

const measureButton = () => screen.getByTestId("button-measure-mode");
const readout = () => screen.queryByTestId("text-measure-readout");

beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.reject(new Error("no network in this test")));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the measure tool in the toolbar", () => {
  it("is offered to a cleaner, who gets no pin controls", () => {
    render(<Harness canEditPins={false} />);
    expect(measureButton()).toBeTruthy();
    // Measuring saves nothing, so there is nothing to keep a cleaner out of —
    // but adding pins is still dispatch work.
    expect(screen.queryByTestId("button-drop-pin")).toBeNull();
  });

  it("sits beside Drop a pin for dispatch", () => {
    render(<Harness canEditPins={true} />);
    expect(screen.getByTestId("button-drop-pin")).toBeTruthy();
    expect(measureButton()).toBeTruthy();
  });

  it("walks from prompt to first point to an actual driving distance", () => {
    render(<Harness canEditPins={false} />);
    expect(readout()).toBeNull();

    fireEvent.click(measureButton());
    expect(measureButton().getAttribute("aria-pressed")).toBe("true");
    expect(readout()!.textContent).toContain("Click two spots");

    fireEvent.click(screen.getByTestId("fake-map-click-a"));
    // One end placed: the tool asks for the other rather than showing half a
    // measurement.
    expect(readout()!.textContent).toContain("Sarah M.");
    expect(readout()!.textContent).toContain("now click the second spot");
    expect(screen.queryByTestId("text-measure-distance")).toBeNull();

    fireEvent.click(screen.getByTestId("fake-map-click-b"));
    const distance = screen.getByTestId("text-measure-distance").textContent!;
    expect(distance).toBe("12 km driving");
    expect(readout()!.textContent).toContain("23 min");
    // The clicked marker's own name on one end, a plain fallback on the bare
    // map click at the other.
    expect(readout()!.textContent).toContain("Sarah M. → Point B");

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never substitutes straight-line math when routing is unavailable", () => {
    render(<Harness canEditPins={false} routeState="error" />);
    fireEvent.click(measureButton());
    fireEvent.click(screen.getByTestId("fake-map-click-a"));
    fireEvent.click(screen.getByTestId("fake-map-click-b"));

    expect(readout()!.textContent).toContain("Driving route unavailable");
    expect(readout()!.textContent).not.toContain("straight-line");
    expect(readout()!.textContent).not.toContain("estimate");
  });

  it("starts over on a third click", () => {
    render(<Harness canEditPins={false} />);
    fireEvent.click(measureButton());
    fireEvent.click(screen.getByTestId("fake-map-click-a"));
    fireEvent.click(screen.getByTestId("fake-map-click-b"));
    expect(screen.getByTestId("text-measure-distance")).toBeTruthy();

    fireEvent.click(screen.getByTestId("fake-map-click-a"));
    expect(screen.queryByTestId("text-measure-distance")).toBeNull();
    expect(readout()!.textContent).toContain("now click the second spot");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Clear wipes the measurement and turns measuring off", () => {
    render(<Harness canEditPins={false} />);
    fireEvent.click(measureButton());
    fireEvent.click(screen.getByTestId("fake-map-click-a"));
    fireEvent.click(screen.getByTestId("fake-map-click-b"));

    fireEvent.click(screen.getByTestId("button-measure-clear"));
    expect(readout()).toBeNull();
    expect(measureButton().getAttribute("aria-pressed")).toBe("false");
    expect(measureButton().textContent).toContain("Measure");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("turning measure on turns drop-pin mode off, and vice versa", () => {
    render(<Harness canEditPins={true} />);
    const drop = () => screen.getByTestId("button-drop-pin");

    fireEvent.click(drop());
    expect(drop().getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(measureButton());
    expect(measureButton().getAttribute("aria-pressed")).toBe("true");
    expect(drop().getAttribute("aria-pressed")).toBe("false");

    // Back the other way: arming the pin drop puts the measurement away
    // rather than leaving a half-placed one on the map.
    fireEvent.click(screen.getByTestId("fake-map-click-a"));
    fireEvent.click(drop());
    expect(drop().getAttribute("aria-pressed")).toBe("true");
    expect(measureButton().getAttribute("aria-pressed")).toBe("false");
    expect(readout()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
