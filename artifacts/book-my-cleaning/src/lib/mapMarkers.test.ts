import { describe, expect, it } from "vitest";
import {
  STALE_AFTER_MS,
  accuracyLabel,
  assigneeNames,
  colorForTeamMember,
  crewChipsFor,
  deviceLabelFor,
  firstName,
  hasCoords,
  initials,
  inkFor,
  isStale,
  lastSeenLabel,
  markerStyleFor,
  partitionJobsByCoords,
  OWNER_MARKER_COLOR,
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

  it("uses the colour the owner picked when there is one", () => {
    expect(colorForTeamMember(7, "#34D399")).toBe("#34d399");
    expect(colorForTeamMember(7, null)).toBe(colorForTeamMember(7));
  });

  it("ignores anything that isn't a plain hex colour", () => {
    // These land in an inline style, so a bad value falls back rather than
    // being painted into the page.
    expect(colorForTeamMember(7, "red; background:url(x)")).toBe(
      colorForTeamMember(7),
    );
    expect(colorForTeamMember(7, "")).toBe(colorForTeamMember(7));
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

describe("crewChipsFor", () => {
  it("maps each assignee to initials + their roster colour", () => {
    const { chips, extra } = crewChipsFor(
      job({
        assignees: [
          { teamMemberId: 1, name: "Jane Doe", color: "#60a5fa" },
          { teamMemberId: 2, name: "Bob" },
        ],
      }),
    );
    expect(chips).toEqual([
      {
        initials: "JD",
        name: "Jane Doe",
        color: "#60a5fa",
        ink: inkFor("#60a5fa"),
      },
      {
        initials: "B",
        name: "Bob",
        color: colorForTeamMember(2),
        ink: inkFor(colorForTeamMember(2)),
      },
    ]);
    expect(extra).toBe(0);
  });

  it("caps the discs and counts the overflow instead of dropping people", () => {
    const assignees = [1, 2, 3, 4, 5].map((id) => ({
      teamMemberId: id,
      name: `Cleaner ${id}`,
    }));
    const { chips, extra } = crewChipsFor(job({ assignees }));
    expect(chips).toHaveLength(3);
    expect(extra).toBe(2);
  });

  it("an unassigned job wears nothing", () => {
    const { chips, extra } = crewChipsFor(job({ assignees: [] }));
    expect(chips).toEqual([]);
    expect(extra).toBe(0);
  });
});

describe("firstName", () => {
  it("keeps just the first name for tight schedule chips", () => {
    expect(firstName("Jane Doe")).toBe("Jane");
    expect(firstName("Cher")).toBe("Cher");
    expect(firstName("  ")).toBe("?");
  });
});

describe("inkFor", () => {
  it("puts dark ink on pastel fills and white on strong ones", () => {
    // The lightest swatches the roster offers — white text vanishes here.
    expect(inkFor("#fde68a")).toBe("#1f2937");
    expect(inkFor("#d9f99d")).toBe("#1f2937");
    expect(inkFor(OWNER_MARKER_COLOR)).toBe("#1f2937");
    // Strong fills keep white.
    expect(inkFor("#7c3aed")).toBe("#ffffff");
    expect(inkFor("hsl(275, 70%, 55%)")).toBe("#ffffff");
    // Unparseable input falls back to white rather than crashing.
    expect(inkFor("papayawhip")).toBe("#ffffff");
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

describe("markerStyleFor", () => {
  it("forces bright yellow with dark ink for every owner device", () => {
    const style = markerStyleFor({
      teamMemberId: 4,
      // Even a roster colour the owner chose himself is overridden — the
      // point is that the boss looks the same on every screen.
      color: "#3355ff",
      isOwner: true,
    });
    expect(style.fill).toBe(OWNER_MARKER_COLOR);
    // Yellow with white text and a white ring would be unreadable on a light
    // map; both must stay dark.
    expect(style.ink).not.toBe("#ffffff");
    expect(style.outline).not.toBe("#ffffff");
  });

  it("leaves everybody else on their roster colour", () => {
    const style = markerStyleFor({ teamMemberId: 4, color: "#3355ff" });
    expect(style.fill).toBe("#3355ff");
    expect(style.fill).not.toBe(OWNER_MARKER_COLOR);
  });

  it("falls back to the id-derived colour when nobody picked one", () => {
    const style = markerStyleFor({ teamMemberId: 7, color: null });
    expect(style.fill).toBe(colorForTeamMember(7, null));
  });
});

describe("deviceLabelFor", () => {
  const boss = { teamMemberId: 1, deviceLabel: "Boss PC" };
  const bossPhone = { teamMemberId: 1, deviceLabel: "Boss iPhone" };
  const cleaner = { teamMemberId: 2, deviceLabel: "Phone" };

  it("names each pin when a person is carrying more than one", () => {
    const all = [boss, bossPhone, cleaner];
    expect(deviceLabelFor(boss, all)).toBe("Boss PC");
    expect(deviceLabelFor(bossPhone, all)).toBe("Boss iPhone");
  });

  it("leaves a lone device unlabelled", () => {
    expect(deviceLabelFor(cleaner, [boss, bossPhone, cleaner])).toBeNull();
  });

  it("says nothing when the device has no name", () => {
    const pair = [
      { teamMemberId: 3, deviceLabel: null },
      { teamMemberId: 3, deviceLabel: "  " },
    ];
    expect(deviceLabelFor(pair[0]!, pair)).toBeNull();
    expect(deviceLabelFor(pair[1]!, pair)).toBeNull();
  });
});
