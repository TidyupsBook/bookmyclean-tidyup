// @vitest-environment jsdom
/**
 * Highlighting a cleaner from the roster strip must dim exactly the visits
 * that are NOT theirs — matching by assignee team-member id — and the dim
 * must win even over the cancelled strike-through style. These tests pin
 * both, so a refactor of assignee shapes can't silently dim the wrong
 * blocks or leave everything dimmed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { BookingRangeItem } from "@workspace/api-client-react";
import { MonthBoard, WeekBoard, isHighlighted } from "./ScheduleCalendar";

const TZ = "America/Toronto";

function booking(overrides: Partial<BookingRangeItem>): BookingRangeItem {
  return {
    bookingId: 1,
    customerName: "Casey Customer",
    service: "Deep clean",
    scheduledFor: "2026-08-10T14:00:00.000Z",
    durationMinutes: 120,
    status: "confirmed",
    located: true,
    assignees: [],
    ...overrides,
  };
}

const ana = { teamMemberId: 7, name: "Ana", color: "#3b82f6" };
const bo = { teamMemberId: 9, name: "Bo", color: "#10b981" };

afterEach(cleanup);

describe("isHighlighted", () => {
  it("matches when any assignee carries the highlighted team-member id", () => {
    expect(isHighlighted(booking({ assignees: [ana] }), 7)).toBe(true);
    // Second-of-two assignees still counts — the visit is theirs too.
    expect(isHighlighted(booking({ assignees: [bo, ana] }), 7)).toBe(true);
  });

  it("does not match a visit assigned to someone else", () => {
    expect(isHighlighted(booking({ assignees: [bo] }), 7)).toBe(false);
  });

  it("never matches an unassigned visit", () => {
    expect(isHighlighted(booking({ assignees: [] }), 7)).toBe(false);
  });

  it("matches nothing when no highlight is active", () => {
    expect(isHighlighted(booking({ assignees: [ana] }), null)).toBe(false);
    expect(isHighlighted(booking({ assignees: [ana] }), undefined)).toBe(false);
  });
});

/** The dim treatment blocks get when they're not the highlighted cleaner's. */
function isDimmed(el: HTMLElement): boolean {
  return el.style.opacity === "0.18";
}

const boards = [
  {
    name: "WeekBoard",
    testId: (id: number) => `block-booking-${id}`,
    renderBoard: (
      bookings: BookingRangeItem[],
      highlight: number | null | undefined,
    ) =>
      render(
        <WeekBoard
          dates={["2026-08-10"]}
          today="2026-08-10"
          bookingsByDay={{ "2026-08-10": bookings }}
          timeZone={TZ}
          onOpenDay={() => {}}
          onSelectBooking={() => {}}
          highlight={highlight}
        />,
      ),
  },
  {
    name: "MonthBoard",
    testId: (id: number) => `chip-booking-${id}`,
    renderBoard: (
      bookings: BookingRangeItem[],
      highlight: number | null | undefined,
    ) =>
      render(
        <MonthBoard
          monthAnchor="2026-08-01"
          dates={["2026-08-10"]}
          today="2026-08-10"
          bookingsByDay={{ "2026-08-10": bookings }}
          timeZone={TZ}
          onOpenDay={() => {}}
          onSelectBooking={() => {}}
          highlight={highlight}
        />,
      ),
  },
] as const;

describe.each(boards)("$name highlight dimming", ({ testId, renderBoard }) => {
  const bookings = [
    booking({ bookingId: 1, assignees: [ana] }),
    booking({ bookingId: 2, assignees: [bo] }),
    booking({ bookingId: 3, assignees: [] }), // needs a crew
  ];

  it("keeps the highlighted cleaner's blocks full-strength and dims the rest", () => {
    renderBoard(bookings, ana.teamMemberId);
    expect(isDimmed(screen.getByTestId(testId(1)))).toBe(false);
    expect(isDimmed(screen.getByTestId(testId(2)))).toBe(true);
    // Unassigned work isn't the highlighted cleaner's — it dims too.
    expect(isDimmed(screen.getByTestId(testId(3)))).toBe(true);
  });

  it("dims nothing when no highlight is active", () => {
    renderBoard(bookings, null);
    for (const id of [1, 2, 3]) {
      expect(isDimmed(screen.getByTestId(testId(id)))).toBe(false);
    }
  });

  it("the dim wins over the cancelled half-opacity on someone else's cancelled visit", () => {
    renderBoard(
      [booking({ bookingId: 4, assignees: [bo], status: "canceled" })],
      ana.teamMemberId,
    );
    const block = screen.getByTestId(testId(4));
    // Cancelled alone would be opacity 0.5; the dim must overwrite it.
    expect(block.style.opacity).toBe("0.18");
    // But the strike-through stays — cancelled is still visible as cancelled.
    expect(block.style.textDecoration).toBe("line-through");
  });

  it("a highlighted cleaner's own cancelled visit keeps the cancelled look, undimmed", () => {
    renderBoard(
      [booking({ bookingId: 5, assignees: [ana], status: "canceled" })],
      ana.teamMemberId,
    );
    const block = screen.getByTestId(testId(5));
    expect(block.style.opacity).toBe("0.5");
    expect(block.style.textDecoration).toBe("line-through");
  });
});
