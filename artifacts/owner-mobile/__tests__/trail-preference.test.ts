/**
 * The Map tab's trails switch, as stored on the phone.
 *
 * "Off" is the only value worth writing: never set, unreadable, or junk all
 * have to read as on, because the trails were on the map before this switch
 * existed and a bad value must never quietly take information away.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
let failing = false;

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => {
      if (failing) throw new Error("storage unavailable");
      return store.get(k) ?? null;
    },
    setItem: async (k: string, v: string) => {
      if (failing) throw new Error("storage unavailable");
      store.set(k, v);
    },
  },
}));

import {
  loadShowTrails,
  parseShowTrails,
  saveShowTrails,
  showTrailsKey,
} from "@/lib/trail-preference";

beforeEach(() => {
  store.clear();
  failing = false;
});

describe("the trails switch", () => {
  it("keeps one choice per signed-in person", () => {
    expect(showTrailsKey("boss@x.test")).not.toBe(showTrailsKey("crew@x.test"));
    expect(showTrailsKey("")).toContain("anon");
  });

  it("reads as on for anything that isn't an explicit off", () => {
    expect(parseShowTrails(null)).toBe(true);
    expect(parseShowTrails("on")).toBe(true);
    expect(parseShowTrails("banana")).toBe(true);
    expect(parseShowTrails("off")).toBe(false);
  });

  it("remembers being switched off, and back on", async () => {
    expect(await loadShowTrails("boss@x.test")).toBe(true);

    await saveShowTrails("boss@x.test", false);
    expect(await loadShowTrails("boss@x.test")).toBe(false);
    // One person's choice doesn't reach into anybody else's.
    expect(await loadShowTrails("crew@x.test")).toBe(true);

    await saveShowTrails("boss@x.test", true);
    expect(await loadShowTrails("boss@x.test")).toBe(true);
  });

  it("still shows the trails when the phone's storage won't answer", async () => {
    failing = true;
    expect(await loadShowTrails("boss@x.test")).toBe(true);
    await expect(saveShowTrails("boss@x.test", false)).resolves.toBeUndefined();
  });
});
