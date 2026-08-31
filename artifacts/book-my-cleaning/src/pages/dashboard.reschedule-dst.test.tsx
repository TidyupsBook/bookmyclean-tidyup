// @vitest-environment jsdom
/**
 * The dashboard's "review" reschedule widget (ReviewRow, shown when a
 * booking's timezone offset shifted) has its own datetime-local input and
 * its own call to zonedInputToIso, separate from the "Edit & reschedule"
 * form on the Bookings page (see bookings.reschedule-dst.test.tsx). It must
 * resolve an ambiguous fall-back hour the same way: the earlier, still-
 * daylight-saving pass.
 *
 * On 2026-11-01 in America/New_York, clocks fall back from 1:59:59 AM EDT to
 * 1:00:00 AM EST, so the wall clock "01:30 AM" happens twice that morning.
 * There is no UI to pick "first" or "second" occurrence, so the dispatcher
 * must land on a single, predictable instant — and the confirmation toast
 * plus the "(was ...)" comparison text must agree with what actually saved.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { formatZoned, zoneLabel } from "@/lib/time";

function query(data?: unknown) {
  return { data, isLoading: false };
}
function mutation() {
  return { mutate: vi.fn(), isPending: false };
}

const updateMutate = vi.fn();
const toast = vi.fn();

const TIMEZONE = "America/New_York";
const PREVIOUS_TIMEZONE = "America/Denver";

function reviewBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: 501,
    customerName: "Jordan Blake",
    customerPhone: "555-0199",
    service: "Deep clean",
    // Oct 31 at 6:30 PM EDT — safely before the fall-back transition.
    scheduledFor: "2026-10-31T22:30:00.000Z",
    status: "pending",
    needsTimeReview: true,
    timeReviewPreviousTimezone: PREVIOUS_TIMEZONE,
    ...overrides,
  };
}

let bookingsFixture: ReturnType<typeof reviewBooking>[] = [];

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  // Keep the hand-written helpers (bookingDisplayName, ...) real — they are
  // pure functions the component under test leans on.
  ...(await importOriginal<Record<string, unknown>>()),
  useGetDashboardSummary: () =>
    query({
      revenueThisMonth: 100,
      callsToday: 0,
      upcomingBookings: bookingsFixture.length,
      pendingBookings: bookingsFixture.length,
      completedThisMonth: 0,
    }),
  useGetRecentActivity: () => query([]),
  useGetCurrentUser: () => query({ id: 1, name: "Pat", role: "owner" }),
  useGetCompany: () =>
    query({
      id: 1,
      name: "Sparkle Co",
      timezone: TIMEZONE,
      isLive: true,
      quoConnected: false,
    }),
  useUpdateCompany: mutation,
  getGetCompanyQueryKey: () => ["/api/company"],
  useListBookings: () => query(bookingsFixture),
  getListBookingsQueryKey: () => ["/api/bookings"],
  getGetDashboardSummaryQueryKey: () => ["/api/dashboard/summary"],
  useConfirmBookingTime: mutation,
  useUpdateBooking: () => ({ mutate: updateMutate, isPending: false }),
  useSendRescheduleText: mutation,
  useGetRescheduleTextPreview: () => query(undefined),
  useResendGivenUpText: mutation,
  getGetRecentActivityQueryKey: () => ["/api/dashboard/activity"],
  useListCalls: () => query([]),
  getListCallsQueryKey: () => ["/api/calls"],
  useGetMapConfig: () => query(undefined),
  useGetMapData: () => query(undefined),
  getGetMapDataQueryKey: () => ["/api/map"],
  useGetSchedule: () => query(undefined),
  getGetScheduleQueryKey: () => ["/api/schedule"],
  useListStaffConversations: () => query([]),
  getListStaffConversationsQueryKey: () => ["/api/staff-chat/conversations"],
  useGetStaffConversation: () => query(undefined),
  getGetStaffConversationQueryKey: (id: number) => [
    "/api/staff-chat/conversations",
    id,
  ],
  useSendStaffMessage: mutation,
}));

vi.mock("@/components/layout/AppLayout", () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/components/DatabasePausedNotice", () => ({
  DatabasePausedNotice: () => null,
  useDatabasePaused: () => false,
}));
vi.mock("@/components/JobberSyncButton", () => ({
  JobberSyncButton: () => null,
}));
vi.mock("@/components/MiniMap", () => ({ MiniMap: () => null }));
vi.mock("@/components/CleanerRoster", () => ({
  useHiddenCleaners: () => [new Set<number>(), vi.fn()],
  useHiddenPins: () => [new Set<string>(), vi.fn()],
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast }),
}));

import { DashboardPage } from "./dashboard";

// jsdom has no layout engine, so scrollIntoView doesn't exist there.
window.HTMLElement.prototype.scrollIntoView = () => {};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DashboardPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  updateMutate.mockReset();
  toast.mockReset();
  cleanup();
  vi.useRealTimers();
});

describe("Rescheduling into the repeated fall-back hour from the dashboard's time-review widget", () => {
  it("resolves to the first (daylight) pass, and the toast agrees with what got saved", async () => {
    // ReviewRow only shows bookings scheduled in the future. Freeze "now" to
    // a date safely before the fixture's Oct 31 appointment so this test
    // stays valid regardless of when it actually runs.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
    bookingsFixture = [reviewBooking()];
    renderPage();

    // The panel starts in "confirm or adjust" mode, showing the shifted
    // time and what it used to say in the previous zone.
    expect(
      screen.getByText(
        (_, node) => node?.textContent === "Jordan Blake — Deep clean",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Adjust" }));

    // Type the ambiguous wall clock straight into the datetime-local box —
    // ReviewRow's own input, distinct from the Bookings page's edit form.
    const input = screen.getByLabelText(
      `New time for Jordan Blake's booking (${zoneLabel(TIMEZONE)})`,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2026-11-01T01:30" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(updateMutate).toHaveBeenCalledTimes(1);
    const [request, callbacks] = updateMutate.mock.calls[0]!;
    expect(request).toEqual({
      id: 501,
      data: {
        // 01:30 in the repeated hour resolves to the EDT (UTC-4) pass, i.e.
        // 05:30 UTC — not the EST (UTC-5) pass an hour later.
        scheduledFor: "2026-11-01T05:30:00.000Z",
      },
    });

    const savedIso = request.data.scheduledFor;
    // The saved instant, read back in the company's zone, must be the wall
    // clock the dispatcher typed — not its hour-shifted DST neighbour.
    expect(formatZoned(savedIso, TIMEZONE)).toContain("1:30");

    await act(async () => callbacks.onSuccess());

    // The confirmation toast must describe the exact instant that was
    // saved, in the company's zone — including the DST abbreviation for
    // that instant (EDT), not whatever offset happens to be current "now".
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Booking rescheduled",
        description: `Jordan Blake is now booked for ${formatZoned(savedIso, TIMEZONE)} ${zoneLabel(TIMEZONE, new Date(savedIso))}.`,
      }),
    );

    // Saving from this widget also offers to text the customer the new
    // time — that offer must show the same resolved instant too.
    expect(
      screen.getByText("Text Jordan Blake the new time?"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, node) =>
          node?.textContent ===
          `${formatZoned(savedIso, TIMEZONE)} ${zoneLabel(TIMEZONE, new Date(savedIso))}`,
      ),
    ).toBeInTheDocument();
  });

  it("keeps the pre-adjustment '(was ...)' comparison consistent with the previous-timezone reading", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
    bookingsFixture = [reviewBooking()];
    renderPage();

    // Before any edit, the row must show both readings of the *original*
    // scheduled time: the new zone's wall clock and what it used to read in
    // the previous zone — so the dispatcher can judge whether to keep it.
    expect(
      screen.getByText(
        (_, node) =>
          node?.textContent ===
          `Now shows ${formatZoned("2026-10-31T22:30:00.000Z", TIMEZONE)} ${zoneLabel(TIMEZONE, new Date("2026-10-31T22:30:00.000Z"))} (was ${formatZoned("2026-10-31T22:30:00.000Z", PREVIOUS_TIMEZONE)} ${zoneLabel(PREVIOUS_TIMEZONE, new Date("2026-10-31T22:30:00.000Z"))})`,
      ),
    ).toBeInTheDocument();
  });
});
