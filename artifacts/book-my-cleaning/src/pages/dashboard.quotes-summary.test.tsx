// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function query(data?: unknown) {
  return { data, isLoading: false, isError: false };
}

function mutation() {
  return { mutate: vi.fn(), isPending: false };
}

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useGetCurrentUser: () => query({ id: 1, name: "Pat", role: "owner" }),
  useGetDashboardSummary: () =>
    query({
      revenueThisMonth: 100,
      callsToday: 3,
      upcomingBookings: 3,
      pendingBookings: 0,
      completedThisMonth: 2,
      newLeads: 1,
      totalBookings: 6,
      bookingsThisWeek: 2,
      bookingsThisMonth: 5,
    }),
  useGetCompany: () =>
    query({
      id: 1,
      name: "Sparkle Co",
      timezone: "America/Edmonton",
      isLive: true,
      quoConnected: false,
    }),
  useUpdateCompany: mutation,
  getGetCompanyQueryKey: () => ["/api/company"],
  useListBookings: () => query([]),
  getListBookingsQueryKey: () => ["/api/bookings"],
  getGetDashboardSummaryQueryKey: () => ["/api/dashboard/summary"],
  useConfirmBookingTime: mutation,
  useUpdateBooking: mutation,
  useSendRescheduleText: mutation,
  useGetRescheduleTextPreview: () => query(undefined),
  useGetRecentActivity: () => query([]),
  getGetRecentActivityQueryKey: () => ["/api/dashboard/activity"],
  useResendGivenUpText: mutation,
  useListCalls: () => query([]),
  getListCallsQueryKey: () => ["/api/calls"],
  // An unconfigured map keeps this focused dashboard regression independent
  // of the Maps SDK while the quote card is still visible.
  useGetMapConfig: () => query(undefined),
  useGetMapData: () => query(undefined),
  getGetMapDataQueryKey: () => ["/api/map"],
  useListJobberQuotes: () =>
    query([
      {
        id: 1,
        status: "draft",
        clientName: "Ada Home",
        totalCents: 12345,
      },
      { id: 2, status: "awaiting_response", totalCents: null },
      { id: 3, status: "changes_requested" },
      { id: 4, status: "approved" },
      { id: 5, status: "converted" },
      { id: 6, status: "archived" },
    ]),
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
  useHiddenCleaners: () => ({ hidden: new Set<number>() }),
  useHiddenPins: () => ({ hidden: new Set<number>() }),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { DashboardPage } from "./dashboard";

afterEach(cleanup);

describe("dashboard quote summary", () => {
  it("groups active, won, and archived Jobber quote states into the three summary buckets", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, enabled: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <DashboardPage />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("quote-summary-awaiting")).toHaveTextContent("3");
    expect(screen.getByTestId("quote-summary-approved")).toHaveTextContent("2");
    expect(screen.getByTestId("quote-summary-expired")).toHaveTextContent("1");
    expect(screen.getByTestId("link-quotes-summary")).toHaveAttribute(
      "href",
      "/quotes",
    );
    expect(screen.getByTestId("quote-price-list")).toHaveTextContent(
      "Ada Home",
    );
    expect(screen.getByTestId("quote-price-list")).toHaveTextContent("$123.45");
    expect(
      screen.getByTestId("button-continue-dashboard-quote"),
    ).toBeDisabled();
    expect(screen.getByText("Quick quote")).toBeInTheDocument();
    expect(screen.queryByText("Recent Activity")).not.toBeInTheDocument();
    expect(screen.queryByText("Upcoming Schedule")).not.toBeInTheDocument();
  });
});
