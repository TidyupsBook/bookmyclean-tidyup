// @vitest-environment jsdom
/**
 * The Jobber card on the booking detail screen: a synced booking offers
 * "View request in Jobber" and, when a quote exists, "Quote #N in Jobber",
 * each opening the corresponding Jobber web page. Cleaner logins never see
 * the Jobber card at all (the API redacts the URIs; the UI must not render
 * empty affordances either).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// --- Mocks: strip Expo-native modules and the generated API hooks ----------

vi.mock("@expo/vector-icons", () => ({ Feather: () => null }));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("expo-haptics", () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: "success" },
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ back: vi.fn() }),
  useLocalSearchParams: () => ({ id: "7" }),
}));

vi.mock("@/components/Brand", () => ({
  GradientRule: () => null,
}));

vi.mock("@/components/Bookings", () => ({
  QuotePills: () => null,
  StatusBadge: () => null,
}));

vi.mock("@/components/StateViews", () => ({
  LoadingView: () => null,
  ErrorView: () => null,
}));

const openURL = vi.fn();
vi.mock("react-native-web", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    Linking: { openURL: (url: string) => openURL(url) },
  };
});

const hooks = vi.hoisted(() => ({
  me: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  company: {
    data: { timezone: "America/Toronto" } as unknown,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  booking: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    error: null as unknown,
    refetch: vi.fn(),
  },
  getBooking: vi.fn(),
  syncMutate: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  // Keep the hand-written helpers (bookingDisplayName, missingBookingFields,
  // ...) real — they are pure functions the screens under test lean on.
  ...(await importOriginal<Record<string, unknown>>()),
  useGetCurrentUser: () => hooks.me,
  useGetCompany: () => hooks.company,
  useGetBooking: (...args: unknown[]) => {
    hooks.getBooking(...args);
    return hooks.booking;
  },
  // A booking detail route must not quietly fall back to the paged schedule
  // list. If it does, this regression test should fail loudly.
  useListBookings: () => {
    throw new Error("booking detail must fetch by id");
  },
  useUpdateBooking: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useSetBookingCrew: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    reset: vi.fn(),
  }),
  useApproveBooking: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useSyncBookingToJobber: () => ({
    mutate: hooks.syncMutate,
    isPending: false,
  }),
  useListTeamMembers: () => ({ data: [] }),
  getListBookingsQueryKey: () => ["/bookings"],
  getGetBookingQueryKey: (id: number) => ["/bookings", id],
}));

import BookingDetailScreen from "@/app/booking/[id]";

// --- Fixtures ---------------------------------------------------------------

const baseBooking = {
  id: 7,
  customerName: "Dana",
  customerPhone: "555-0100",
  service: "Deep clean",
  status: "confirmed",
  scheduledFor: "2026-08-10T14:00:00.000Z",
  jobberSynced: true,
  jobberSyncError: null,
  crew: [],
};

function renderScreen() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <BookingDetailScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  hooks.me.data = { role: "owner", teamMemberId: null };
  hooks.company.data = {
    timezone: "America/Toronto",
    jobberConnected: true,
    jobberNeedsReauth: false,
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe("Jobber links on the booking detail screen", () => {
  it("fetches the pin's booking by id without needing schedule-list data", () => {
    hooks.booking.data = { ...baseBooking };

    const { getByText } = renderScreen();

    expect(hooks.getBooking).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        query: expect.objectContaining({
          enabled: true,
        }),
      }),
    );
    expect(getByText("Dana")).toBeTruthy();
  });

  it("shows both links for a synced booking with a quote, opening Jobber", () => {
    hooks.booking.data = {
      ...baseBooking,
      jobberWebUri: "https://secure.getjobber.com/work_orders/5",
      jobberQuoteNumber: "12",
      jobberQuoteWebUri: "https://secure.getjobber.com/quotes/9",
    };
    const { getByTestId, getByText } = renderScreen();

    fireEvent.click(getByTestId("link-jobber-request"));
    expect(openURL).toHaveBeenCalledWith(
      "https://secure.getjobber.com/work_orders/5",
    );

    expect(getByText("Quote #12 in Jobber")).toBeTruthy();
    fireEvent.click(getByTestId("link-jobber-quote"));
    expect(openURL).toHaveBeenCalledWith(
      "https://secure.getjobber.com/quotes/9",
    );
  });

  it("omits the quote link when no quote was raised, and falls back to a generic label without a number", () => {
    hooks.booking.data = {
      ...baseBooking,
      jobberWebUri: "https://secure.getjobber.com/work_orders/5",
      jobberQuoteNumber: null,
      jobberQuoteWebUri: null,
    };
    const { getByTestId, queryByTestId } = renderScreen();
    expect(getByTestId("link-jobber-request")).toBeTruthy();
    expect(queryByTestId("link-jobber-quote")).toBeNull();
    cleanup();

    hooks.booking.data = {
      ...baseBooking,
      jobberWebUri: null,
      jobberQuoteNumber: null,
      jobberQuoteWebUri: "https://secure.getjobber.com/quotes/9",
    };
    const second = renderScreen();
    expect(second.queryByTestId("link-jobber-request")).toBeNull();
    expect(second.getByText("View quote in Jobber")).toBeTruthy();
  });

  it("renders no Jobber links when the API redacted them (synced, but no URIs)", () => {
    hooks.booking.data = {
      ...baseBooking,
      jobberWebUri: null,
      jobberQuoteWebUri: null,
    };
    const { queryByTestId, getByText } = renderScreen();
    expect(getByText("Synced to Jobber")).toBeTruthy();
    expect(queryByTestId("link-jobber-request")).toBeNull();
    expect(queryByTestId("link-jobber-quote")).toBeNull();
  });

  it("shows the next automatic retry and remaining budget", () => {
    hooks.booking.data = {
      ...baseBooking,
      jobberSynced: false,
      jobberSyncError: "Jobber is unavailable",
      jobberSyncErrorAt: "2026-08-10T12:00:00.000Z",
      jobberAutomaticRetryStatus: "pending",
      jobberAutomaticRetriesRemaining: 3,
      jobberNextRetryAt: "2099-08-10T12:04:00.000Z",
    };

    const { getByTestId } = renderScreen();
    const status = getByTestId("jobber-retry-status");
    expect(status.textContent).toContain("Automatic retry pending");
    expect(status.textContent).toContain("3 automatic retries remaining");
    expect(status.textContent).toContain("Next automatic retry");
  });

  it("keeps manual Sync to Jobber available after automatic retries are exhausted", () => {
    hooks.company.data = {
      timezone: "America/Toronto",
      jobberConnected: true,
      jobberNeedsReauth: true,
    };
    hooks.booking.data = {
      ...baseBooking,
      jobberSynced: false,
      jobberSyncError: "Jobber is unavailable",
      jobberSyncErrorAt: "2026-08-10T12:00:00.000Z",
      jobberAutomaticRetryStatus: "exhausted",
      jobberAutomaticRetriesRemaining: 0,
      jobberNextRetryAt: null,
      jobberRetryUsesBookingConnection: true,
    };

    const { getByTestId } = renderScreen();
    expect(getByTestId("jobber-retry-status").textContent).toContain(
      "Automatic retries exhausted",
    );
    fireEvent.click(getByTestId("button-detail-sync-jobber"));
    expect(hooks.syncMutate).toHaveBeenCalledWith(
      { id: 7 },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it("does not offer Sync for a primary booking until Jobber is reconnected", () => {
    hooks.company.data = {
      timezone: "America/Toronto",
      jobberConnected: true,
      jobberNeedsReauth: true,
    };
    hooks.booking.data = {
      ...baseBooking,
      jobberSynced: false,
      jobberSyncError: "Jobber is unavailable",
      jobberSyncErrorAt: "2026-08-10T12:00:00.000Z",
      jobberAutomaticRetryStatus: "exhausted",
      jobberAutomaticRetriesRemaining: 0,
      jobberNextRetryAt: null,
      jobberRetryUsesBookingConnection: false,
    };

    const { queryByTestId } = renderScreen();
    expect(queryByTestId("button-detail-sync-jobber")).toBeNull();
  });

  it("does not offer the generic sync action for manual-only failures", () => {
    hooks.booking.data = {
      ...baseBooking,
      jobberSynced: true,
      jobberSyncError: "Could not update this job's Jobber visit: unavailable",
      jobberSyncErrorAt: "2026-08-10T12:00:00.000Z",
      jobberAutomaticRetryStatus: "manual",
      jobberAutomaticRetriesRemaining: null,
      jobberNextRetryAt: null,
    };

    const { getByTestId, queryByTestId } = renderScreen();
    expect(getByTestId("jobber-retry-status").textContent).toContain(
      "Automatic retries stopped",
    );
    expect(queryByTestId("button-detail-sync-jobber")).toBeNull();
  });

  it("links the draft quote before the booking is marked synced", () => {
    // The quote is drafted with the booking, so hiding the link until the row
    // goes green would hide a quote that already exists in Jobber.
    hooks.booking.data = {
      ...baseBooking,
      jobberSynced: false,
      jobberWebUri: null,
      jobberQuoteNumber: "31",
      jobberQuoteWebUri: "https://secure.getjobber.com/quotes/31",
    };
    const { getByTestId, queryByText } = renderScreen();

    expect(getByTestId("link-jobber-quote")).toBeTruthy();
    expect(queryByText("Not synced to Jobber.")).toBeNull();
  });

  it("shows nothing Jobber-related to a cleaner login", () => {
    hooks.me.data = { role: "cleaner", teamMemberId: 3 };
    hooks.booking.data = {
      ...baseBooking,
      jobberWebUri: "https://secure.getjobber.com/work_orders/5",
      jobberQuoteWebUri: "https://secure.getjobber.com/quotes/9",
    };
    const { queryByTestId, queryByText } = renderScreen();
    expect(queryByText("Synced to Jobber")).toBeNull();
    expect(queryByTestId("link-jobber-request")).toBeNull();
    expect(queryByTestId("link-jobber-quote")).toBeNull();
  });
});
