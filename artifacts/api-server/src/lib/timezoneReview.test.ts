import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * flagShiftedBookings must compare each booking's UTC offset in the old vs new
 * zone *at the booking's own instant*. Zone pairs like America/Phoenix (no
 * DST) vs America/Denver share an offset half the year and differ the other
 * half, so these tests pin bookings in both halves.
 */

type Row = {
  id: number;
  scheduledFor: Date;
  needsTimeReview: boolean;
  status: string;
};

let rows: Row[] = [];
let updateCalls: Array<{ set: Record<string, unknown>; ids: number[] }> = [];

vi.mock("@workspace/db", () => {
  const bookingsTable = {
    id: { __col: "id" },
    scheduledFor: { __col: "scheduledFor" },
    needsTimeReview: { __col: "needsTimeReview" },
    status: { __col: "status" },
    companyId: { __col: "companyId" },
  };
  const db = {
    select: () => ({
      from: () => ({
        where: async () => rows,
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async (cond: { ids: number[] }) => {
          updateCalls.push({ set: values, ids: cond.ids });
        },
      }),
    }),
  };
  return { db, bookingsTable };
});

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  gt: (a: unknown, b: unknown) => ({ gt: [a, b] }),
  // Capture the ids handed to the UPDATE's inArray so tests can assert on them.
  inArray: (_col: unknown, ids: number[]) => ({ ids }),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { flagShiftedBookings } from "./timezoneReview";

const booking = (
  id: number,
  isoInstant: string,
  needsTimeReview = false,
): Row => ({
  id,
  scheduledFor: new Date(isoInstant),
  needsTimeReview,
  status: "confirmed",
});

// 2027 keeps every booking safely in the future for years of test runs.
const WINTER = "2027-01-15T16:00:00.000Z"; // Denver MST −7, Phoenix −7
const SUMMER = "2027-07-15T15:00:00.000Z"; // Denver MDT −6, Phoenix −7

beforeEach(() => {
  rows = [];
  updateCalls = [];
});

describe("flagShiftedBookings", () => {
  it("does not flag when both zones render the same wall clock (same offset)", async () => {
    // Phoenix vs Denver in January: both UTC-7.
    rows = [booking(1, WINTER)];
    const count = await flagShiftedBookings(
      1,
      "America/Phoenix",
      "America/Denver",
    );
    expect(count).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });

  it("flags a DST-dependent pair only for bookings whose instant falls in the differing half", async () => {
    rows = [booking(1, WINTER), booking(2, SUMMER)];
    const count = await flagShiftedBookings(
      1,
      "America/Phoenix",
      "America/Denver",
    );
    expect(count).toBe(1);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.ids).toEqual([2]); // only the summer booking shifted
    expect(updateCalls[0]!.set).toMatchObject({
      needsTimeReview: true,
      timeReviewPreviousTimezone: "America/Phoenix",
    });
  });

  it("flags every future booking for zones a fixed hour apart year-round", async () => {
    rows = [booking(1, WINTER), booking(2, SUMMER)];
    // Denver and Chicago are always one hour apart (both observe DST).
    const count = await flagShiftedBookings(
      1,
      "America/Denver",
      "America/Chicago",
    );
    expect(count).toBe(2);
    expect(updateCalls[0]!.ids).toEqual([1, 2]);
  });

  it("never flags when the timezone label changes but offsets always match", async () => {
    rows = [booking(1, WINTER), booking(2, SUMMER)];
    // Denver and Boise are the same offset all year.
    const count = await flagShiftedBookings(
      1,
      "America/Denver",
      "America/Boise",
    );
    expect(count).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });

  it("skips bookings already awaiting review, preserving their original previous timezone", async () => {
    // Simulates a repeated switch: booking 1 was flagged during an earlier
    // change and must NOT have timeReviewPreviousTimezone overwritten.
    rows = [booking(1, SUMMER, true), booking(2, SUMMER)];
    const count = await flagShiftedBookings(
      1,
      "America/Denver",
      "America/Phoenix",
    );
    expect(count).toBe(1);
    expect(updateCalls[0]!.ids).toEqual([2]); // booking 1 untouched
  });

  it("returns 0 and issues no update when nothing shifts on a repeated switch", async () => {
    rows = [booking(1, SUMMER, true)];
    const count = await flagShiftedBookings(
      1,
      "America/Denver",
      "America/Phoenix",
    );
    expect(count).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });

  it("flags conservatively when a zone name cannot be resolved", async () => {
    rows = [booking(1, WINTER)];
    const count = await flagShiftedBookings(1, "Not/AZone", "America/Denver");
    expect(count).toBe(1);
    expect(updateCalls[0]!.ids).toEqual([1]);
  });
});
