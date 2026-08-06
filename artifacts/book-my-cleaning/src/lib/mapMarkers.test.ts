import { describe, expect, it } from "vitest";
import {
  STALE_AFTER_MS,
  accuracyLabel,
  assigneeNames,
  colorForTeamMember,
  hasCoords,
  initials,
  isStale,
  lastSeenLabel,
  partitionJobsByCoords,
} from "./mapMarkers";
import type { MapJob } from "@workspace/api-client-react";

const NOW = Date.parse("2026-08-08T12:00:00.000Z");

function job(overrides: Partial<MapJob>): MapJob {
  return {
    bookingId: 1,
    customerName: "Acme",
    customerAddress: "1 Main St",
    lat: 51,
    lng: -114,
    scheduledFor: "2026-08-08T16:00:00.000Z",
    status: "confirmed",
    assignees: [],
    ...overrides,
  };
}

describe("colorForTeamMember", () => {
  it("is stable for the same id", () => {
    expect(colorForTeamMember(7)).toBe(colorForTeamMember(7));
  });

  it("gives different hues to different ids", () => {
    expect(colorForTeamMember(1)).not.toBe(colorForTeamMember(2));
  });

  it("returns a valid hsl string", () => {
    expect(colorForTeamMember(42)).toMatch(/^hsl\(\d{1,3}, 70%, 55%\)$/);
  });
});

describe("initials", () => {
  it("takes first and last initial", () => {
    expect(initials("Jane Doe")).toBe("JD");
    expect(initials("mary jane watson")).toBe("MW");
  });

  it("handles a single name", () => {
    expect(initials("Cher")).toBe("C");
  });

  it("falls back to ? for empty", () => {
    expect(initials("   ")).toBe("?");
  });
});

describe("isStale", () => {
  it("is fresh just under the threshold", () => {
    const at = new Date(NOW - (STALE_AFTER_MS - 1000)).toISOString();
    expect(isStale(at, NOW)).toBe(false);
  });

  it("is stale past the threshold", () => {
    const at = new Date(NOW - (STALE_AFTER_MS + 1000)).toISOString();
    expect(isStale(at, NOW)).toBe(true);
  });

  it("treats an unparseable timestamp as stale", () => {
    expect(isStale("nonsense", NOW)).toBe(true);
  });
});

describe("lastSeenLabel", () => {
  it("says just now under a minute", () => {
    expect(lastSeenLabel(new Date(NOW - 30 * 1000).toISOString(), NOW)).toBe(
      "just now",
    );
  });

  it("reports minutes and hours", () => {
    expect(
      lastSeenLabel(new Date(NOW - 20 * 60 * 1000).toISOString(), NOW),
    ).toBe("20 min ago");
    expect(
      lastSeenLabel(new Date(NOW - 3 * 60 * 60 * 1000).toISOString(), NOW),
    ).toBe("3 hr ago");
  });
});

describe("hasCoords", () => {
  it("accepts real coordinates", () => {
    expect(hasCoords({ lat: 51.05, lng: -114.07 })).toBe(true);
  });

  it("rejects null and the 0,0 null-island sentinel", () => {
    expect(hasCoords({ lat: null, lng: null })).toBe(false);
    expect(hasCoords({ lat: 0, lng: 0 })).toBe(false);
  });
});

describe("partitionJobsByCoords", () => {
  it("separates located jobs from ungeocoded ones", () => {
    const jobs = [
      job({ bookingId: 1, lat: 51, lng: -114 }),
      job({
        bookingId: 2,
        lat: null as unknown as number,
        lng: null as unknown as number,
      }),
      job({ bookingId: 3, lat: 0, lng: 0 }),
    ];
    const { located, unlocated } = partitionJobsByCoords(jobs);
    expect(located.map((j) => j.bookingId)).toEqual([1]);
    expect(unlocated.map((j) => j.bookingId)).toEqual([2, 3]);
  });
});

describe("assigneeNames", () => {
  it("joins names and falls back to Unassigned", () => {
    expect(
      assigneeNames(
        job({
          assignees: [
            { teamMemberId: 1, name: "Jane" },
            { teamMemberId: 2, name: "Bob" },
          ],
        }),
      ),
    ).toBe("Jane, Bob");
    expect(assigneeNames(job({ assignees: [] }))).toBe("Unassigned");
  });
});

describe("accuracyLabel", () => {
  it("rounds metres and handles missing accuracy", () => {
    expect(
      accuracyLabel({
        teamMemberId: 1,
        name: "Jane",
        lat: 51,
        lng: -114,
        accuracy: 12.7,
        updatedAt: new Date(NOW).toISOString(),
      }),
    ).toBe("±13 m");
    expect(
      accuracyLabel({
        teamMemberId: 1,
        name: "Jane",
        lat: 51,
        lng: -114,
        accuracy: null,
        updatedAt: new Date(NOW).toISOString(),
      }),
    ).toBeNull();
  });
});
