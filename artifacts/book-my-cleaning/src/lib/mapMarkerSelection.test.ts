/**
 * Pins the rules both maps share. The roster hide list removes live cars but
 * never touches homes, job pins or saved pins. The saved-pin
 * hide list removes exactly the unchecked saved pins and nothing else. Job
 * pins — client properties — can never be hidden by either. A refactor of
 * either map's drawing effect that crossed those wires would break these
 * tests before it broke a dispatcher's day.
 */
import { describe, it, expect } from "vitest";
import { selectMapMarkers, selectionFramePoints } from "./mapMarkerSelection";

const cleaner = (teamMemberId: number, lat = 53.5, lng = -113.5) => ({
  teamMemberId,
  lat,
  lng,
});
const home = (teamMemberId: number, lat = 53.6, lng = -113.4) => ({
  teamMemberId,
  lat,
  lng,
});
const job = (bookingId: number, lat = 53.55, lng = -113.45) => ({
  bookingId,
  lat,
  lng,
});
const pin = (id: number, lat = 53.52, lng = -113.42) => ({ id, lat, lng });

const none = () => new Set<number>();

describe("selectMapMarkers", () => {
  it("excludes hidden cleaners' live cars but keeps every home", () => {
    const out = selectMapMarkers(
      {
        cleaners: [cleaner(1), cleaner(2)],
        staffHomes: [home(1), home(2)],
      },
      new Set([1]),
      none(),
    );
    expect(out.cleaners.map((c) => c.teamMemberId)).toEqual([2]);
    expect(out.staffHomes.map((s) => s.teamMemberId)).toEqual([1, 2]);
  });

  it("always includes jobs and saved pins, whatever the cleaner hide list says", () => {
    // Ids deliberately collide with hidden team-member ids: a job's bookingId
    // or a pin's id must never be mistaken for a person to hide.
    const out = selectMapMarkers(
      {
        cleaners: [cleaner(1)],
        jobs: [job(1), job(2)],
        pins: [pin(1), pin(2)],
        staffHomes: [home(1)],
      },
      new Set([1, 2]),
      none(),
    );
    expect(out.cleaners).toEqual([]);
    expect(out.staffHomes.map((s) => s.teamMemberId)).toEqual([1]);
    expect(out.jobs.map((j) => j.bookingId)).toEqual([1, 2]);
    expect(out.pins.map((p) => p.id)).toEqual([1, 2]);
  });

  it("hides exactly the unchecked saved pins — people and jobs unaffected", () => {
    // Ids deliberately collide across kinds again, in the other direction:
    // hiding pin 1 must not hide cleaner 1's car, their house, or job 1.
    const out = selectMapMarkers(
      {
        cleaners: [cleaner(1), cleaner(2)],
        jobs: [job(1), job(2)],
        pins: [pin(1), pin(2)],
        staffHomes: [home(1), home(2)],
      },
      none(),
      new Set([1]),
    );
    expect(out.pins.map((p) => p.id)).toEqual([2]);
    expect(out.cleaners.map((c) => c.teamMemberId)).toEqual([1, 2]);
    expect(out.staffHomes.map((s) => s.teamMemberId)).toEqual([1, 2]);
    expect(out.jobs.map((j) => j.bookingId)).toEqual([1, 2]);
  });

  it("keeps the two hide lists separate even when every id collides", () => {
    const out = selectMapMarkers(
      {
        cleaners: [cleaner(1)],
        jobs: [job(1)],
        pins: [pin(1)],
        staffHomes: [home(1)],
      },
      new Set([1]), // hides cleaner 1's live car…
      none(), // …while the pin list is empty: pin 1 must survive
    );
    expect(out.cleaners).toEqual([]);
    expect(out.staffHomes.map((s) => s.teamMemberId)).toEqual([1]);
    expect(out.pins.map((p) => p.id)).toEqual([1]);
    expect(out.jobs.map((j) => j.bookingId)).toEqual([1]);
  });

  it("drops anything without drawable coordinates", () => {
    const out = selectMapMarkers(
      {
        cleaners: [{ teamMemberId: 1, lat: null, lng: null }, cleaner(2)],
        jobs: [{ bookingId: 1 }, job(2), { bookingId: 3, lat: 0, lng: 0 }],
        pins: [{ id: 1, lat: NaN, lng: -113 }, pin(2)],
        staffHomes: [{ teamMemberId: 3, lat: 53, lng: undefined }, home(4)],
      },
      none(),
      none(),
    );
    expect(out.cleaners.map((c) => c.teamMemberId)).toEqual([2]);
    expect(out.jobs.map((j) => j.bookingId)).toEqual([2]);
    expect(out.pins.map((p) => p.id)).toEqual([2]);
    expect(out.staffHomes.map((s) => s.teamMemberId)).toEqual([4]);
  });

  it("handles missing data gracefully", () => {
    expect(selectMapMarkers(undefined, new Set([1]), new Set([2]))).toEqual({
      cleaners: [],
      jobs: [],
      pins: [],
      staffHomes: [],
    });
    expect(selectMapMarkers({}, none(), none())).toEqual({
      cleaners: [],
      jobs: [],
      pins: [],
      staffHomes: [],
    });
  });

  it("keeps framing unchanged when everything is visible", () => {
    const data = {
      cleaners: [cleaner(1, 53.5, -113.5)],
      jobs: [job(10, 53.55, -113.45)],
      pins: [pin(20, 53.52, -113.42)],
      staffHomes: [home(1, 53.6, -113.4)],
    };
    const points = selectionFramePoints(selectMapMarkers(data, none(), none()));
    // Every drawable point, in draw order: cleaners, jobs, pins, homes.
    expect(points).toEqual([
      { lat: 53.5, lng: -113.5 },
      { lat: 53.55, lng: -113.45 },
      { lat: 53.52, lng: -113.42 },
      { lat: 53.6, lng: -113.4 },
    ]);
  });

  it("frames only the drawn markers when someone is hidden — places stay", () => {
    const data = {
      cleaners: [cleaner(1, 53.5, -113.5)],
      jobs: [job(10, 53.55, -113.45)],
      pins: [pin(20, 53.52, -113.42)],
      staffHomes: [home(1, 53.6, -113.4)],
    };
    const points = selectionFramePoints(
      selectMapMarkers(data, new Set([1]), none()),
    );
    expect(points).toEqual([
      { lat: 53.55, lng: -113.45 },
      { lat: 53.52, lng: -113.42 },
      { lat: 53.6, lng: -113.4 },
    ]);
  });

  it("frames without a hidden pin, so the view can't stretch toward it", () => {
    const data = {
      cleaners: [cleaner(1, 53.5, -113.5)],
      jobs: [job(10, 53.55, -113.45)],
      pins: [pin(20, 53.52, -113.42)],
      staffHomes: [home(1, 53.6, -113.4)],
    };
    const points = selectionFramePoints(
      selectMapMarkers(data, none(), new Set([20])),
    );
    expect(points).toEqual([
      { lat: 53.5, lng: -113.5 },
      { lat: 53.55, lng: -113.45 },
      { lat: 53.6, lng: -113.4 },
    ]);
  });
});
