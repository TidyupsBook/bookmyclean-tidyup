import { describe, expect, it } from "vitest";
import {
  buildRoster,
  hiddenCleanersKey,
  loadHiddenCleaners,
  loadRosterCollapsed,
  loadShowTrails,
  rosterCollapsedKey,
  saveHiddenCleaners,
  saveRosterCollapsed,
  saveShowTrails,
  showTrailsKey,
  toggleHidden,
} from "./cleanerRoster";
import { STALE_AFTER_MS } from "./mapMarkers";

const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);

const home = (id: number, name: string, extra: Partial<any> = {}) => ({
  teamMemberId: id,
  name,
  color: null,
  roleLabel: "Cleaner",
  address: "1 Main St",
  lat: 53.5 + id / 100,
  lng: -113.5,
  active: true,
  ...extra,
});

const live = (
  id: number,
  name: string,
  agoMs: number,
  extra: Partial<any> = {},
) => ({
  teamMemberId: id,
  name,
  color: null,
  lat: 53.6 + id / 100,
  lng: -113.4,
  updatedAt: new Date(NOW - agoMs).toISOString(),
  ...extra,
});

describe("buildRoster", () => {
  it("lists every active cleaner once, sorted by name", () => {
    const roster = buildRoster(
      {
        staffHomes: [home(2, "Zoe"), home(1, "Amy")],
        cleaners: [live(1, "Amy", 1000)],
        staffWithoutHome: [
          {
            teamMemberId: 3,
            name: "Ben",
            roleLabel: "Cleaner",
            active: true,
            reason: "missing" as const,
          },
        ],
      },
      NOW,
    );
    expect(roster.map((r) => r.name)).toEqual(["Amy", "Ben", "Zoe"]);
    expect(roster.filter((r) => r.teamMemberId === 1)).toHaveLength(1);
  });

  it("skips inactive crew entirely", () => {
    const roster = buildRoster(
      {
        staffHomes: [home(1, "Amy", { active: false })],
        staffWithoutHome: [
          {
            teamMemberId: 2,
            name: "Ben",
            roleLabel: "Cleaner",
            active: false,
            reason: "missing" as const,
          },
        ],
      },
      NOW,
    );
    expect(roster).toEqual([]);
  });

  it("prefers a fresh live position over home as the click target", () => {
    const roster = buildRoster(
      { staffHomes: [home(1, "Amy")], cleaners: [live(1, "Amy", 1000)] },
      NOW,
    );
    expect(roster[0]!.focus?.source).toBe("live");
    expect(roster[0]!.live).toBe(true);
  });

  it("falls back to home when the live position has gone stale", () => {
    const roster = buildRoster(
      {
        staffHomes: [home(1, "Amy")],
        cleaners: [live(1, "Amy", STALE_AFTER_MS + 60_000)],
      },
      NOW,
    );
    expect(roster[0]!.focus?.source).toBe("home");
    expect(roster[0]!.live).toBe(false);
  });

  it("leaves focus null for someone with no coordinates at all", () => {
    const roster = buildRoster(
      {
        staffWithoutHome: [
          {
            teamMemberId: 9,
            name: "Ben",
            roleLabel: "Cleaner",
            active: true,
            reason: "missing" as const,
          },
        ],
      },
      NOW,
    );
    expect(roster[0]!.focus).toBeNull();
  });
});

describe("hidden cleaner persistence", () => {
  const fakeStorage = () => {
    const bag = new Map<string, string>();
    return {
      getItem: (k: string) => bag.get(k) ?? null,
      setItem: (k: string, v: string) => void bag.set(k, v),
    };
  };

  it("round-trips a hide list", () => {
    const storage = fakeStorage();
    const key = hiddenCleanersKey("owner@example.com");
    saveHiddenCleaners(storage, key, new Set([3, 1]));
    expect(loadHiddenCleaners(storage, key)).toEqual(new Set([1, 3]));
  });

  it("treats corrupt or missing data as 'show everyone'", () => {
    const storage = fakeStorage();
    expect(loadHiddenCleaners(storage, "nope")).toEqual(new Set());
    storage.setItem("bad", "{not json");
    expect(loadHiddenCleaners(storage, "bad")).toEqual(new Set());
    storage.setItem("wrong", JSON.stringify({ a: 1 }));
    expect(loadHiddenCleaners(storage, "wrong")).toEqual(new Set());
    storage.setItem("mixed", JSON.stringify([1, "x", 2]));
    expect(loadHiddenCleaners(storage, "mixed")).toEqual(new Set([1, 2]));
  });

  it("survives a storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadHiddenCleaners(broken, "k")).toEqual(new Set());
    expect(() => saveHiddenCleaners(broken, "k", new Set([1]))).not.toThrow();
  });

  it("toggles without mutating the original set", () => {
    const original = new Set([1]);
    const on = toggleHidden(original, 2);
    expect(on).toEqual(new Set([1, 2]));
    expect(toggleHidden(on, 1)).toEqual(new Set([2]));
    expect(original).toEqual(new Set([1]));
  });
});

describe("the roster collapse preference", () => {
  const store = () => {
    const values = new Map<string, string>();
    return {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => void values.set(k, v),
    };
  };

  it("starts open and round-trips one choice per viewer", () => {
    const storage = store();
    const owner = rosterCollapsedKey("owner@example.com");
    const dispatcher = rosterCollapsedKey("dispatch@example.com");
    expect(owner).not.toBe(dispatcher);
    expect(loadRosterCollapsed(storage, owner)).toBe(false);

    saveRosterCollapsed(storage, owner, true);
    expect(loadRosterCollapsed(storage, owner)).toBe(true);
    expect(loadRosterCollapsed(storage, dispatcher)).toBe(false);

    saveRosterCollapsed(storage, owner, false);
    expect(loadRosterCollapsed(storage, owner)).toBe(false);
  });

  it("fails open when storage is blocked or contains junk", () => {
    expect(loadRosterCollapsed({ getItem: () => "maybe" }, "k")).toBe(false);
    expect(
      loadRosterCollapsed(
        {
          getItem: () => {
            throw new Error("blocked");
          },
        },
        "k",
      ),
    ).toBe(false);
    expect(() =>
      saveRosterCollapsed(
        {
          setItem: () => {
            throw new Error("full");
          },
        },
        "k",
        true,
      ),
    ).not.toThrow();
  });
});

/**
 * The owner's "draw the trails" switch. Off is the only value worth storing:
 * everything else — never set, unreadable, junk — has to mean "on", because
 * the trails were on the map before this switch existed.
 */
describe("the trails switch", () => {
  const store = () => {
    const values = new Map<string, string>();
    return {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => {
        values.set(k, v);
      },
      values,
    };
  };

  it("keeps one choice per signed-in user", () => {
    expect(showTrailsKey("boss@x.test")).not.toBe(showTrailsKey("disp@x.test"));
    // Signed out reads a slot of its own rather than somebody else's.
    expect(showTrailsKey("")).toContain("anon");
  });

  it("is on until it has been switched off", () => {
    const s = store();
    const key = showTrailsKey("boss@x.test");
    expect(loadShowTrails(s, key)).toBe(true);

    saveShowTrails(s, key, false);
    expect(loadShowTrails(s, key)).toBe(false);

    saveShowTrails(s, key, true);
    expect(loadShowTrails(s, key)).toBe(true);
  });

  it("shows the trails when storage is unusable or holds junk", () => {
    const key = showTrailsKey("boss@x.test");
    expect(loadShowTrails(null, key)).toBe(true);
    expect(
      loadShowTrails(
        {
          getItem: () => {
            throw new Error("blocked");
          },
        },
        key,
      ),
    ).toBe(true);
    expect(loadShowTrails({ getItem: () => "banana" }, key)).toBe(true);

    // A blocked write must not throw at the person flipping the switch.
    expect(() =>
      saveShowTrails(
        {
          setItem: () => {
            throw new Error("full");
          },
        },
        key,
        false,
      ),
    ).not.toThrow();
  });

  it("doesn't share a slot with either hide list", () => {
    const s = store();
    saveShowTrails(s, showTrailsKey("boss@x.test"), false);
    expect(loadHiddenCleaners(s, hiddenCleanersKey("boss@x.test")).size).toBe(
      0,
    );
  });
});
