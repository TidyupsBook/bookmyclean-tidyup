import { describe, expect, it, vi } from "vitest";
import { closeMapMarkerCard, toggleMapMarkerCard } from "./mapInfoWindow";

describe("toggleMapMarkerCard", () => {
  it("opens, replaces, then closes when the current pin is clicked again", () => {
    const infoWindow = {
      setContent: vi.fn(),
      open: vi.fn(),
      close: vi.fn(),
    };
    const openMarker = { current: null as string | null };
    const map = {};
    const first = {};
    const second = {};

    expect(
      toggleMapMarkerCard({
        key: "job:1",
        marker: first,
        content: "First",
        map,
        infoWindow,
        openMarker,
      }),
    ).toBe(true);
    expect(openMarker.current).toBe("job:1");

    toggleMapMarkerCard({
      key: "pin:2",
      marker: second,
      content: "Second",
      map,
      infoWindow,
      openMarker,
    });
    expect(openMarker.current).toBe("pin:2");
    expect(infoWindow.open).toHaveBeenLastCalledWith({ map, anchor: second });

    expect(
      toggleMapMarkerCard({
        key: "pin:2",
        marker: second,
        content: "Second",
        map,
        infoWindow,
        openMarker,
      }),
    ).toBe(false);
    expect(infoWindow.close).toHaveBeenCalledOnce();
    expect(openMarker.current).toBeNull();
  });

  it("clears an open key before a data refresh creates replacement markers", () => {
    const infoWindow = {
      setContent: vi.fn(),
      open: vi.fn(),
      close: vi.fn(),
    };
    const openMarker = { current: "job:1" as string | null };

    closeMapMarkerCard(infoWindow, openMarker);
    expect(openMarker.current).toBeNull();
    expect(infoWindow.close).toHaveBeenCalledOnce();

    const replacement = {};
    expect(
      toggleMapMarkerCard({
        key: "job:1",
        marker: replacement,
        content: "Refreshed job",
        map: {},
        infoWindow,
        openMarker,
      }),
    ).toBe(true);
    expect(infoWindow.open).toHaveBeenCalledOnce();
    expect(openMarker.current).toBe("job:1");
  });
});
