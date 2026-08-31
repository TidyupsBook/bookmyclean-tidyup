import { describe, it, expect } from "vitest";
import { shouldChime, totalStaffUnread } from "./unread";

describe("totalStaffUnread", () => {
  it("adds up every conversation", () => {
    expect(
      totalStaffUnread([
        { unreadCount: 2 },
        { unreadCount: 0 },
        { unreadCount: 3 },
      ]),
    ).toBe(5);
  });

  it("is zero before the list has loaded", () => {
    expect(totalStaffUnread(undefined)).toBe(0);
    expect(totalStaffUnread([])).toBe(0);
  });

  it("ignores a negative count rather than subtracting it", () => {
    // Defensive: a bad count must never hide unread messages in other threads.
    expect(totalStaffUnread([{ unreadCount: -4 }, { unreadCount: 2 }])).toBe(2);
  });
});

describe("shouldChime", () => {
  it("stays silent on the first tally, however big", () => {
    // Signing in to a backlog is not eleven new arrivals.
    expect(shouldChime(null, 11)).toBe(false);
  });

  it("sounds when the count goes up", () => {
    expect(shouldChime(0, 1)).toBe(true);
    expect(shouldChime(3, 5)).toBe(true);
  });

  it("stays silent when nothing changed", () => {
    expect(shouldChime(4, 4)).toBe(false);
    expect(shouldChime(0, 0)).toBe(false);
  });

  it("stays silent while messages are being read", () => {
    expect(shouldChime(6, 2)).toBe(false);
    expect(shouldChime(1, 0)).toBe(false);
  });
});
