import { describe, expect, it } from "vitest";
import { pickNextJob } from "./nextJob";

const NOW = new Date("2026-08-09T18:00:00Z");

let seq = 0;
function job(
  iso: string,
  over: Partial<{
    id: number;
    durationMinutes: number | null;
    lat: number | null;
    lng: number | null;
    status: string;
  }> = {},
) {
  return {
    id: over.id ?? ++seq,
    scheduledFor: new Date(iso),
    // `??` would turn an explicit null (no duration on file) into 60.
    durationMinutes:
      over.durationMinutes === undefined ? 60 : over.durationMinutes,
    lat: over.lat === undefined ? 53.5 : over.lat,
    lng: over.lng === undefined ? -113.5 : over.lng,
    status: over.status ?? "confirmed",
  };
}

describe("pickNextJob", () => {
  it("picks the earliest upcoming job", () => {
    const later = job("2026-08-09T21:00:00Z");
    const sooner = job("2026-08-09T19:00:00Z");
    expect(pickNextJob([later, sooner], NOW)).toBe(sooner);
  });

  it("skips completed and canceled work", () => {
    const done = job("2026-08-09T19:00:00Z", { status: "completed" });
    const gone = job("2026-08-09T19:30:00Z", { status: "canceled" });
    const real = job("2026-08-09T20:00:00Z", { status: "pending" });
    expect(pickNextJob([done, gone, real], NOW)).toBe(real);
  });

  it("skips a job the map can't place, even when it's sooner", () => {
    const unlocated = job("2026-08-09T18:30:00Z", { lat: null, lng: null });
    const located = job("2026-08-09T20:00:00Z");
    expect(pickNextJob([unlocated, located], NOW)).toBe(located);
  });

  it("keeps pointing at a job that started but whose window hasn't passed", () => {
    // Started an hour ago, two-hour job: they're on site or running late —
    // either way it is still the destination.
    const inProgress = job("2026-08-09T17:00:00Z", { durationMinutes: 120 });
    const afternoon = job("2026-08-09T21:00:00Z");
    expect(pickNextJob([inProgress, afternoon], NOW)).toBe(inProgress);
  });

  it("stops pointing at a job whose whole window has passed", () => {
    // 3 hours ago, one-hour job nobody marked completed: pointing the trail
    // backwards all afternoon helps no one.
    const missed = job("2026-08-09T15:00:00Z", { durationMinutes: 60 });
    const next = job("2026-08-09T20:00:00Z");
    expect(pickNextJob([missed, next], NOW)).toBe(next);
  });

  it("assumes two hours when a booking has no duration", () => {
    // 90 minutes in with no duration on file — still within the default window.
    const openEnded = job("2026-08-09T16:30:00Z", { durationMinutes: null });
    expect(pickNextJob([openEnded], NOW)).toBe(openEnded);
    // 2.5 hours in — past it.
    const stale = job("2026-08-09T15:30:00Z", { durationMinutes: null });
    expect(pickNextJob([stale], NOW)).toBeNull();
  });

  it("breaks a same-minute tie by id so the answer never flaps", () => {
    const b = job("2026-08-09T19:00:00Z", { id: 12 });
    const a = job("2026-08-09T19:00:00Z", { id: 5 });
    expect(pickNextJob([b, a], NOW)).toBe(a);
  });

  it("returns null when nothing qualifies", () => {
    expect(pickNextJob([], NOW)).toBeNull();
  });
});
