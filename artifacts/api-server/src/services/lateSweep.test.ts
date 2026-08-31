import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sweep's contract: one activity entry per booking per slip — including
 * when sweeps overlap — a back-on-time entry when the slip ends, and a
 * restart must reconstruct the episode from the feed (latest late vs
 * back-on-time entry wins), so a slip already announced stays quiet while a
 * booking that recovered before the restart is news again. The route-leg
 * computation and the DB are stubbed: the lateness rule itself is covered in
 * lib/lateness.test.ts, and the durable insert dedupe in lib/lateActivity.ts
 * is emulated faithfully here (same window, same key).
 */

type ActivityRow = {
  companyId: number;
  type: string;
  message: string;
  bookingId: number | null;
  occurredAt: Date;
};

let activityRows: ActivityRow[];
let failNextInsert: boolean;

const bookingsMarker = vi.hoisted(() => ({ marker: "bookings" }));

vi.mock("@workspace/db", () => ({
  db: {
    // Two reads come through here: the seed query (today's lateness entries
    // from activityTable) and the customer-name lookup (bookingsTable).
    select: () => ({
      from: (table: unknown) => ({
        where: async () =>
          table === bookingsMarker
            ? [{ customerName: "Sarah M." }]
            : activityRows.map((r) => ({
                bookingId: r.bookingId,
                type: r.type,
                occurredAt: r.occurredAt,
              })),
      }),
    }),
  },
  activityTable: {
    companyId: {},
    type: {},
    bookingId: {},
    occurredAt: {},
  },
  bookingsTable: bookingsMarker,
  companiesTable: {},
  cleanerLocationsTable: {},
}));

// In-memory stand-in for the transactional check-then-insert, applying the
// real window rule (keyed on company + booking + type) to the captured rows.
vi.mock("../lib/lateActivity", async () => {
  const { LATE_ENTRY_DEDUPE_MS } = await vi.importActual<
    typeof import("../lib/lateActivity")
  >("../lib/lateActivity");
  return {
    LATE_ENTRY_DEDUPE_MS,
    insertLateEntryOnce: async (
      companyId: number,
      entry: { bookingId: number; type: string; message: string },
      nowMs: number,
    ) => {
      if (failNextInsert) {
        failNextInsert = false;
        throw new Error("db hiccup");
      }
      const dupe = activityRows.some(
        (r) =>
          r.companyId === companyId &&
          r.type === entry.type &&
          r.bookingId === entry.bookingId &&
          r.occurredAt.getTime() > nowMs - LATE_ENTRY_DEDUPE_MS,
      );
      if (dupe) return false;
      activityRows.push({
        companyId,
        type: entry.type,
        message: entry.message,
        bookingId: entry.bookingId,
        occurredAt: new Date(nowMs),
      });
      return true;
    },
  };
});

import { sweepCompanyLateness, resetLateSweepState } from "./lateSweep";
import type { RouteLeg } from "../lib/routeLegs";

const NOW = Date.UTC(2026, 7, 9, 18, 0, 0);
const COMPANY = { id: 9001, timezone: "America/Edmonton" };

function routeLeg(over: Partial<RouteLeg> = {}): RouteLeg {
  return {
    teamMemberId: 7,
    name: "Casey Cleaner",
    color: null,
    bookingId: 42,
    customerName: "Sarah M.",
    customerAddress: "12 Oak St",
    destLat: 53.56,
    destLng: -113.51,
    // Booked 11:00, arriving 12:15 — 75 minutes behind.
    scheduledFor: new Date(Date.UTC(2026, 7, 9, 17, 0, 0)).toISOString(),
    etaSeconds: 15 * 60,
    distanceMeters: 8400,
    source: "estimate",
    path: [],
    ...over,
  };
}

/** A trail for the same booking that is comfortably early. */
function onTimeLeg(): RouteLeg {
  return routeLeg({
    scheduledFor: new Date(Date.UTC(2026, 7, 9, 18, 30, 0)).toISOString(),
  });
}

function rowsOfType(type: string) {
  return activityRows.filter((r) => r.type === type);
}

beforeEach(() => {
  activityRows = [];
  failNextInsert = false;
  resetLateSweepState();
});

describe("sweepCompanyLateness", () => {
  it("writes one feed entry the sweep a booking first slips, then stays quiet", async () => {
    const legs = async () => [routeLeg()];
    await sweepCompanyLateness(COMPANY, NOW, legs);
    expect(activityRows).toHaveLength(1);
    expect(activityRows[0]).toMatchObject({
      companyId: 9001,
      type: "cleaner_running_late",
      bookingId: 42,
    });
    expect(activityRows[0]!.message).toContain("Casey Cleaner is running late");

    // Same slip on the next sweep — no second entry.
    await sweepCompanyLateness(COMPANY, NOW + 60_000, legs);
    expect(activityRows).toHaveLength(1);
  });

  it("two overlapping sweeps for the same slip still write exactly one entry", async () => {
    // A legs provider slow enough that the second sweep arrives while the
    // first is still awaiting it — the exact interleaving the per-company
    // lock exists for.
    const slowLegs = () =>
      new Promise<RouteLeg[]>((resolve) =>
        setTimeout(() => resolve([routeLeg()]), 10),
      );
    await Promise.all([
      sweepCompanyLateness(COMPANY, NOW, slowLegs),
      sweepCompanyLateness(COMPANY, NOW + 1_000, slowLegs),
    ]);
    expect(rowsOfType("cleaner_running_late")).toHaveLength(1);
  });

  it("a failed feed write is retried on the next sweep, not lost", async () => {
    const legs = async () => [routeLeg()];
    failNextInsert = true;

    // The write fails — the sweep must not remember the slip as announced.
    await sweepCompanyLateness(COMPANY, NOW, legs);
    expect(activityRows).toHaveLength(0);

    // Next sweep, still late: the entry finally lands, exactly once.
    await sweepCompanyLateness(COMPANY, NOW + 60_000, legs);
    expect(activityRows).toHaveLength(1);
    await sweepCompanyLateness(COMPANY, NOW + 120_000, legs);
    expect(activityRows).toHaveLength(1);
  });

  it("writes nothing for an on-time trail", async () => {
    await sweepCompanyLateness(COMPANY, NOW, async () => [onTimeLeg()]);
    expect(activityRows).toEqual([]);
  });

  it("posts a back-on-time entry when the slip ends, and a re-slip is news again", async () => {
    await sweepCompanyLateness(COMPANY, NOW, async () => [routeLeg()]);
    expect(rowsOfType("cleaner_running_late")).toHaveLength(1);

    // Seen back on time: the recovery entry lands, once.
    await sweepCompanyLateness(COMPANY, NOW + 120_000, async () => [
      onTimeLeg(),
    ]);
    const recovered = rowsOfType("cleaner_back_on_time");
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.message).toContain("Sarah M.");
    await sweepCompanyLateness(COMPANY, NOW + 180_000, async () => [
      onTimeLeg(),
    ]);
    expect(rowsOfType("cleaner_back_on_time")).toHaveLength(1);

    // Slipping again is a new slip — a second late entry.
    await sweepCompanyLateness(COMPANY, NOW + 240_000, async () => [
      routeLeg(),
    ]);
    expect(rowsOfType("cleaner_running_late")).toHaveLength(2);
  });

  it("a failed recovery write is retried on the next sweep", async () => {
    await sweepCompanyLateness(COMPANY, NOW, async () => [routeLeg()]);
    failNextInsert = true;
    await sweepCompanyLateness(COMPANY, NOW + 120_000, async () => [
      onTimeLeg(),
    ]);
    expect(rowsOfType("cleaner_back_on_time")).toHaveLength(0);

    await sweepCompanyLateness(COMPANY, NOW + 180_000, async () => [
      onTimeLeg(),
    ]);
    expect(rowsOfType("cleaner_back_on_time")).toHaveLength(1);
  });

  it("a restart mid-slip re-seeds from today's feed and stays quiet", async () => {
    // The feed already carries this booking's entry from before the restart.
    activityRows.push({
      companyId: 9001,
      type: "cleaner_running_late",
      message: "Casey Cleaner is running late — …",
      bookingId: 42,
      occurredAt: new Date(NOW - 10 * 60_000),
    });

    await sweepCompanyLateness(COMPANY, NOW, async () => [routeLeg()]);
    expect(rowsOfType("cleaner_running_late")).toHaveLength(1); // no duplicate

    // Seen back on time, then slipping again — that's a new slip, new entry.
    await sweepCompanyLateness(COMPANY, NOW + 120_000, async () => [
      onTimeLeg(),
    ]);
    await sweepCompanyLateness(COMPANY, NOW + 240_000, async () => [
      routeLeg(),
    ]);
    expect(rowsOfType("cleaner_running_late")).toHaveLength(2);
  });

  it("a booking that recovered before the restart is announced on a new slip", async () => {
    // Pre-restart feed: slipped, then recovered — the episode is closed.
    activityRows.push(
      {
        companyId: 9001,
        type: "cleaner_running_late",
        message: "Casey Cleaner is running late — …",
        bookingId: 42,
        occurredAt: new Date(NOW - 60 * 60_000),
      },
      {
        companyId: 9001,
        type: "cleaner_back_on_time",
        message: "Back on schedule for Sarah M. — …",
        bookingId: 42,
        occurredAt: new Date(NOW - 30 * 60_000),
      },
    );

    // First sweep after restart already sees the new slip: it must announce.
    await sweepCompanyLateness(COMPANY, NOW, async () => [routeLeg()]);
    expect(rowsOfType("cleaner_running_late")).toHaveLength(2);
  });
});
