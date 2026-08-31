// @vitest-environment jsdom
/**
 * Highlighting a cleaner from the roster strip must carry into the Day view:
 * other crews' lanes (and the unassigned lane) dim exactly like month/week
 * blocks do, and clearing the highlight restores everyone. These tests pin
 * that so the filter feeling can't silently break when drilling into a day.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ScheduleCleaner, ScheduleJob } from "@workspace/api-client-react";
import { DayView } from "./schedule";

const TZ = "America/Toronto";

function job(overrides: Partial<ScheduleJob>): ScheduleJob {
  return {
    bookingId: 1,
    customerName: "Casey Customer",
    customerAddress: "12 Main St",
    customerPhone: "555-0100",
    service: "Deep clean",
    scheduledFor: "2026-08-10T14:00:00.000Z",
    durationMinutes: 120,
    price: null,
    status: "confirmed",
    ...overrides,
  } as ScheduleJob;
}

function cleaner(
  teamMemberId: number,
  name: string,
  jobs: ScheduleJob[],
): ScheduleCleaner {
  return { teamMemberId, name, color: null, jobs } as ScheduleCleaner;
}

const schedule = {
  cleaners: [
    cleaner(7, "Ana", [job({ bookingId: 1 })]),
    cleaner(9, "Bo", [job({ bookingId: 2 })]),
  ],
  unassigned: [job({ bookingId: 3 })],
};

function renderDay(highlight: number | null | undefined) {
  return render(
    <DayView
      schedule={schedule}
      isLoading={false}
      date="2026-08-10"
      timeZone={TZ}
      onSelectBooking={() => {}}
      highlight={highlight}
    />,
  );
}

const isDimmed = (el: HTMLElement) => el.style.opacity === "0.18";

afterEach(cleanup);

describe("DayView highlight dimming", () => {
  it("keeps the highlighted cleaner's lane full-strength and dims the rest", () => {
    renderDay(7);
    expect(isDimmed(screen.getByTestId("lane-cleaner-7"))).toBe(false);
    expect(isDimmed(screen.getByTestId("lane-cleaner-9"))).toBe(true);
    // Unassigned work isn't the highlighted cleaner's — it dims too.
    expect(isDimmed(screen.getByTestId("lane-unassigned"))).toBe(true);
  });

  it("dims nothing when no highlight is active", () => {
    for (const highlight of [null, undefined]) {
      renderDay(highlight);
      expect(isDimmed(screen.getByTestId("lane-cleaner-7"))).toBe(false);
      expect(isDimmed(screen.getByTestId("lane-cleaner-9"))).toBe(false);
      expect(isDimmed(screen.getByTestId("lane-unassigned"))).toBe(false);
      cleanup();
    }
  });
});
