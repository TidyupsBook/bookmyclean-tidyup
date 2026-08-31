// @vitest-environment jsdom
/**
 * The approval and Jobber scheduling flows on the booking detail screen.
 *
 * Pending bookings record approval without opening scheduling. Bookings that
 * are already approved can open the crew picker and schedule in Jobber.
 * Active bookings always get a plain "Assign / Change crew" button.
 *
 * NOTE: The crew picker is conditionally rendered when the owner opens it, so
 * tests must click the trigger button before interacting with picker content.
 * Use fireEvent.click (not .press) because the jsdom env uses the web API.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// --- Mocks ------------------------------------------------------------------

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
  useLocalSearchParams: () => ({ id: "42" }),
}));

vi.mock("@/components/Brand", () => ({ GradientRule: () => null }));

vi.mock("@/components/Bookings", () => ({
  QuotePills: () => null,
  StatusBadge: () => null,
}));

vi.mock("@/components/StateViews", () => ({
  LoadingView: () => null,
  ErrorView: () => null,
}));

vi.mock("react-native-web", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    Linking: { openURL: vi.fn() },
  };
});

// Mutable so each test can configure its own state.
const hooks = vi.hoisted(() => ({
  me: {
    data: { role: "owner", teamMemberId: null } as unknown,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  company: {
    data: {
      timezone: "America/Toronto",
      jobberConnected: true,
      jobberNeedsReauth: false,
    } as unknown,
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
  setCrew: {
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
    isError: false,
    error: null as unknown,
    reset: vi.fn(),
  },
  approve: {
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null as unknown,
  },
  team: {
    data: [
      { id: 1, name: "Alice", role: "cleaner", active: true, hasLogin: true },
      { id: 2, name: "Bob", role: "cleaner", active: true, hasLogin: false },
    ] as unknown,
  },
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetCurrentUser: () => hooks.me,
  useGetCompany: () => hooks.company,
  useGetBooking: () => hooks.booking,
  useUpdateBooking: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useSetBookingCrew: () => hooks.setCrew,
  useApproveBooking: () => hooks.approve,
  useSyncBookingToJobber: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useListTeamMembers: () => hooks.team,
  // SendQuoteModal hooks — not exercised by these tests but must be exported.
  useGetQuotePreview: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
  }),
  useSendQuote: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
  getListBookingsQueryKey: () => ["/bookings"],
  getGetBookingQueryKey: (id: number) => ["/bookings", id],
  getGetQuotePreviewQueryKey: (id: number) => ["/quote-preview", id],
  bookingDisplayName: (b: { customerName: string }) => b.customerName,
}));

import BookingDetailScreen from "@/app/booking/[id]";

// --- Fixtures ---------------------------------------------------------------

const pendingBooking = {
  id: 42,
  customerName: "Claire",
  customerPhone: "555-0200",
  service: "Standard clean",
  status: "pending",
  scheduledFor: "2026-09-01T15:00:00.000Z",
  jobberSynced: false,
  jobberSyncError: null,
  jobberCreatedJobId: null,
  jobberQuoteId: "qid_123",
  crew: [],
  quoteTotals: null,
  quoteSentTotals: null,
};

const acceptedPending = {
  ...pendingBooking,
  // clientApprovedAt set → accepted but not yet scheduled in Jobber
  clientApprovedAt: "2026-08-30T10:00:00.000Z",
  jobberCreatedJobId: null,
};

const acceptedScheduled = {
  ...pendingBooking,
  status: "confirmed",
  clientApprovedAt: "2026-08-30T10:00:00.000Z",
  jobberCreatedJobId: "jj_99",
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
  hooks.setCrew.mutate = vi.fn();
  hooks.setCrew.mutateAsync = vi.fn().mockResolvedValue({});
  hooks.setCrew.isPending = false;
  hooks.setCrew.isError = false;
  hooks.setCrew.error = null;
  hooks.setCrew.reset = vi.fn();
  hooks.approve.mutate = vi.fn();
  hooks.approve.isPending = false;
  hooks.approve.isError = false;
  hooks.approve.error = null;
  hooks.team.data = [
    { id: 1, name: "Alice", role: "cleaner", active: true, hasLogin: true },
    { id: 2, name: "Bob", role: "cleaner", active: true, hasLogin: false },
  ];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// --- Tests ------------------------------------------------------------------

describe("Accept action visibility on detail screen", () => {
  it("shows Accept & assign crew for a pending booking", () => {
    hooks.booking.data = pendingBooking;
    const { getByTestId } = renderScreen();
    expect(getByTestId("button-detail-accept")).toBeTruthy();
  });

  it("hides the Accept button for an already-accepted booking", () => {
    hooks.booking.data = acceptedPending;
    const { queryByTestId } = renderScreen();
    expect(queryByTestId("button-detail-accept")).toBeNull();
  });

  it("shows Schedule button for accepted-but-not-scheduled booking", () => {
    hooks.booking.data = acceptedPending;
    const { getByTestId } = renderScreen();
    expect(getByTestId("button-detail-schedule")).toBeTruthy();
  });

  it("labels a Jobber-observed approval without calling it local", () => {
    hooks.booking.data = {
      ...pendingBooking,
      jobberQuoteStatus: "APPROVED",
    };
    const { getByTestId, queryByText } = renderScreen();

    expect(getByTestId("text-approval-source").textContent).toContain(
      "Approved in Jobber",
    );
    expect(queryByText(/recorded by/i)).toBeNull();
  });

  it("hides both schedule and accept buttons once the job is on Jobber's calendar", () => {
    hooks.booking.data = acceptedScheduled;
    const { queryByTestId } = renderScreen();
    expect(queryByTestId("button-detail-accept")).toBeNull();
    expect(queryByTestId("button-detail-schedule")).toBeNull();
  });

  it("shows Assign crew for an active booking with no crew", () => {
    hooks.booking.data = pendingBooking;
    const { getByTestId } = renderScreen();
    expect(getByTestId("button-detail-crew")).toBeTruthy();
  });

  it("shows Change crew when a booking already has crew assigned", () => {
    hooks.booking.data = {
      ...acceptedScheduled,
      crew: [{ id: 1, name: "Alice" }],
    };
    const { getByText } = renderScreen();
    expect(getByText("Change crew")).toBeTruthy();
  });

  it("shows no dispatch actions to a cleaner", () => {
    hooks.me.data = { role: "cleaner", teamMemberId: 1 };
    hooks.booking.data = pendingBooking;
    const { queryByTestId } = renderScreen();
    expect(queryByTestId("button-detail-accept")).toBeNull();
    expect(queryByTestId("button-detail-crew")).toBeNull();
  });

  it("shows Retry scheduling when the booking has a Jobber sync error and awaits scheduling", () => {
    hooks.booking.data = {
      ...acceptedPending,
      jobberSyncError: "Timeout connecting to Jobber",
    };
    const { getByText } = renderScreen();
    expect(getByText("Retry scheduling in Jobber")).toBeTruthy();
  });

  it("renders a disabled schedule indicator when Jobber needs reauth", () => {
    hooks.company.data = {
      timezone: "America/Toronto",
      jobberConnected: true,
      jobberNeedsReauth: true,
    };
    hooks.booking.data = acceptedPending;
    const { getByTestId } = renderScreen();
    // Rendered as a static View (not Pressable) when blocked
    expect(getByTestId("button-detail-schedule")).toBeTruthy();
  });
});

describe("Jobber scheduling picker", () => {
  it("lists crew members after the scheduling picker is opened", () => {
    hooks.booking.data = acceptedPending;
    const { getByTestId, getByText } = renderScreen();
    fireEvent.click(getByTestId("button-detail-schedule"));
    expect(getByTestId("crew-member-1")).toBeTruthy();
    expect(getByText("Alice")).toBeTruthy();
    expect(getByTestId("crew-member-2")).toBeTruthy();
    expect(getByText("Bob")).toBeTruthy();
  });

  it("does not reveal scheduling controls before approval", () => {
    hooks.booking.data = pendingBooking;
    const { getByTestId, queryByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-detail-accept"));
    expect(queryByTestId("button-accept-confirm")).toBeNull();
    expect(hooks.approve.mutate).toHaveBeenCalledWith(
      { id: 42, data: { schedule: false } },
      expect.any(Object),
    );
  });

  it("toggles a crew member on click without throwing", () => {
    hooks.booking.data = acceptedPending;
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-detail-schedule"));
    const aliceRow = getByTestId("crew-member-1");
    fireEvent.click(aliceRow); // select
    fireEvent.click(aliceRow); // deselect — must not throw
  });

  it("confirms with the schedule button after opening the picker", () => {
    hooks.booking.data = acceptedPending;
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-detail-schedule"));
    expect(getByTestId("button-accept-confirm")).toBeTruthy();
  });

  it("shows crew-save button after opening the crew picker", () => {
    hooks.booking.data = pendingBooking;
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-detail-crew"));
    expect(getByTestId("button-crew-save")).toBeTruthy();
  });
});

describe("Scheduling flow — crew saved first, then Jobber", () => {
  it("calls setCrew then approve when a new crew member is selected", async () => {
    hooks.booking.data = acceptedPending;
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-detail-schedule"));
    fireEvent.click(getByTestId("crew-member-1")); // select Alice
    await act(async () => {
      fireEvent.click(getByTestId("button-accept-confirm"));
    });
    expect(hooks.setCrew.mutateAsync).toHaveBeenCalledWith({
      id: 42,
      data: { teamMemberIds: [1] },
    });
    expect(hooks.approve.mutate).toHaveBeenCalledWith(
      { id: 42, data: { schedule: true } },
      expect.any(Object),
    );
  });

  it("skips the crew write when the same crew is already assigned", async () => {
    // Booking already has Alice; picker initialises with Alice selected.
    hooks.booking.data = {
      ...acceptedPending,
      crew: [{ id: 1, name: "Alice" }],
    };
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-detail-schedule"));
    // Don't toggle anyone — picker reflects the current crew unchanged.
    await act(async () => {
      fireEvent.click(getByTestId("button-accept-confirm"));
    });
    expect(hooks.setCrew.mutateAsync).not.toHaveBeenCalled();
    expect(hooks.approve.mutate).toHaveBeenCalledWith(
      { id: 42, data: { schedule: true } },
      expect.any(Object),
    );
  });

  it("schedules when Jobber is the observed approval source", async () => {
    hooks.booking.data = {
      ...pendingBooking,
      jobberQuoteStatus: "APPROVED",
    };
    const { getByTestId } = renderScreen();
    expect(() => getByTestId("button-detail-accept")).toThrow();
    fireEvent.click(getByTestId("button-detail-schedule"));
    await act(async () => {
      fireEvent.click(getByTestId("button-accept-confirm"));
    });
    expect(hooks.approve.mutate).toHaveBeenCalledWith(
      { id: 42, data: { schedule: true } },
      expect.any(Object),
    );
  });
});

describe("Crew assign flow (non-pending / already-accepted booking)", () => {
  it("calls setCrew.mutate when Save crew is pressed", async () => {
    hooks.booking.data = acceptedScheduled;
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-detail-crew")); // open crew picker
    fireEvent.click(getByTestId("crew-member-2")); // select Bob
    await act(async () => {
      fireEvent.click(getByTestId("button-crew-save"));
    });
    expect(hooks.setCrew.mutate).toHaveBeenCalledWith(
      { id: 42, data: { teamMemberIds: [2] } },
      expect.any(Object),
    );
  });

  it("does not call approve when using the plain crew picker", async () => {
    hooks.booking.data = acceptedScheduled;
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-detail-crew"));
    fireEvent.click(getByTestId("crew-member-1"));
    await act(async () => {
      fireEvent.click(getByTestId("button-crew-save"));
    });
    expect(hooks.approve.mutate).not.toHaveBeenCalled();
  });
});
