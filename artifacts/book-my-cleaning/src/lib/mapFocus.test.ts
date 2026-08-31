import { describe, it, expect } from "vitest";
import { parseMapFocus, mapFocusHref } from "./mapFocus";

describe("parseMapFocus", () => {
  it("reads a job and a day", () => {
    expect(parseMapFocus("?job=42&date=2026-08-06")).toEqual({
      jobId: 42,
      date: "2026-08-06",
    });
  });

  it("works without the leading question mark", () => {
    expect(parseMapFocus("job=7")).toEqual({ jobId: 7, date: null });
  });

  it("ignores a job id that isn't a positive whole number", () => {
    expect(parseMapFocus("?job=abc").jobId).toBeNull();
    expect(parseMapFocus("?job=-3").jobId).toBeNull();
    expect(parseMapFocus("?job=0").jobId).toBeNull();
    expect(parseMapFocus("?job=1.5").jobId).toBeNull();
  });

  it("ignores a date that isn't a real YYYY-MM-DD", () => {
    expect(parseMapFocus("?date=tomorrow").date).toBeNull();
    expect(parseMapFocus("?date=2026-8-6").date).toBeNull();
    expect(parseMapFocus("?date=2026-13-40").date).toBeNull();
  });

  it("returns nothing for an empty search", () => {
    expect(parseMapFocus("")).toEqual({ jobId: null, date: null });
  });
});

describe("mapFocusHref", () => {
  it("carries the job and the day", () => {
    expect(mapFocusHref(12, "2026-08-06")).toBe("/map?job=12&date=2026-08-06");
  });

  it("drops a missing or malformed day", () => {
    expect(mapFocusHref(12, null)).toBe("/map?job=12");
    expect(mapFocusHref(12, "nonsense")).toBe("/map?job=12");
  });
});
