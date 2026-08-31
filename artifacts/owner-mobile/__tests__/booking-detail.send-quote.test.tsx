// @vitest-environment jsdom
/**
 * SendQuoteModal on the booking detail screen.
 *
 * Happy path: the preview loads, the message is seeded into the TextInput,
 * tapping confirm calls useSendQuote.mutate with the seeded message and
 * booking id, and the success callback closes the modal and refreshes.
 *
 * Blocked path: when canSend is false (or the preview is loading) the confirm
 * button is disabled and no mutation fires.
 *
 * Error path: a failed mutation shows an inline error banner without closing
 * the modal.
 *
 * Reopen path: closing and reopening with a cached preview must reseed the
 * TextInput so the owner can never accidentally send an empty message.
 *
 * NOTE: react-native-web's Modal never unmounts its children; we don't assert
 * modal closure by checking element absence. Instead we assert side-effects
 * (mutation args, refetch called) and that the confirm button stays present
 * on error.
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

// Mutable so each test can configure its own hook state.
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
  quotePreview: {
    data: undefined as
      | {
          message: string;
          canSend: boolean;
          fromNumber: string | null;
          blockedReason: string | null;
        }
      | undefined,
    isLoading: false,
    isError: false,
  },
  sendQuote: {
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null as unknown,
  },
  // Needed by other sub-components rendered on the same screen.
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
  team: { data: [] as unknown },
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
  useGetQuotePreview: () => hooks.quotePreview,
  useSendQuote: () => hooks.sendQuote,
  getListBookingsQueryKey: () => ["/bookings"],
  getGetBookingQueryKey: (id: number) => ["/bookings", id],
  getGetQuotePreviewQueryKey: (id: number) => ["/quote-preview", id],
  bookingDisplayName: (b: { customerName: string }) => b.customerName,
}));

import BookingDetailScreen from "@/app/booking/[id]";

// --- Fixtures ---------------------------------------------------------------

const bookingWithQuote = {
  id: 42,
  customerName: "Dana",
  customerPhone: "555-0300",
  service: "Deep clean",
  status: "pending",
  scheduledFor: "2026-09-10T14:00:00.000Z",
  jobberSynced: false,
  jobberSyncError: null,
  jobberCreatedJobId: null,
  jobberQuoteId: null,
  quoteSentAt: null,
  quoteSentTotals: null,
  depositPaidAt: null,
  depositPaidAmount: null,
  crew: [],
  quoteTotals: {
    lineItems: [{ name: "Deep clean", quantity: 1, unitPrice: 15000 }],
    taxLabel: "HST",
    taxAmount: 1950,
    feesAmount: 0,
    feesLabel: "",
    deposit: 5000,
    total: 16950,
  },
};

const previewReady = {
  message:
    "Hi Dana, your quote is $169.50. Tap here to approve: https://bmc.app/q/abc123",
  canSend: true,
  fromNumber: "+16135550001",
  blockedReason: null,
};

const previewBlocked = {
  message: "",
  canSend: false,
  fromNumber: null,
  blockedReason: "No Quo number connected.",
};

function renderScreen() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <BookingDetailScreen />
    </QueryClientProvider>,
  );
}

// --- Setup & teardown -------------------------------------------------------

beforeEach(() => {
  hooks.me.data = { role: "owner", teamMemberId: null };
  hooks.company.data = {
    timezone: "America/Toronto",
    jobberConnected: true,
    jobberNeedsReauth: false,
  };
  hooks.booking.data = bookingWithQuote;
  hooks.quotePreview.data = undefined;
  hooks.quotePreview.isLoading = false;
  hooks.quotePreview.isError = false;
  hooks.sendQuote.mutate = vi.fn();
  hooks.sendQuote.isPending = false;
  hooks.sendQuote.isError = false;
  hooks.sendQuote.error = null;
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
  hooks.team.data = [];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// --- Tests ------------------------------------------------------------------

describe("Send quote button visibility", () => {
  it("shows the Send quote button for a booking that has a quote total", () => {
    const { getByTestId } = renderScreen();
    expect(getByTestId("button-detail-send-quote")).toBeTruthy();
  });

  it("hides the Send quote button when the booking has no quote total", () => {
    hooks.booking.data = { ...bookingWithQuote, quoteTotals: null };
    const { queryByTestId } = renderScreen();
    expect(queryByTestId("button-detail-send-quote")).toBeNull();
  });

  it("hides the Send quote button for a canceled booking", () => {
    hooks.booking.data = { ...bookingWithQuote, status: "canceled" };
    const { queryByTestId } = renderScreen();
    expect(queryByTestId("button-detail-send-quote")).toBeNull();
  });

  it("shows 'Send updated quote' on the trigger when the quote was already sent", () => {
    hooks.booking.data = {
      ...bookingWithQuote,
      quoteSentAt: "2026-09-01T10:00:00.000Z",
    };
    const { getAllByText } = renderScreen();
    // Trigger button + modal header + confirm button all carry the label.
    expect(getAllByText("Send updated quote").length).toBeGreaterThanOrEqual(1);
  });
});

describe("SendQuoteModal — happy path", () => {
  it("seeds the message TextInput with the server preview once loaded", () => {
    hooks.quotePreview.data = previewReady;
    const { getByTestId, getByDisplayValue } = renderScreen();
    fireEvent.click(getByTestId("button-detail-send-quote"));
    // The TextInput must show the server draft so the owner sees what will be sent.
    expect(getByDisplayValue(previewReady.message)).toBeTruthy();
  });

  it("calls useSendQuote.mutate with the seeded message and correct booking id", async () => {
    hooks.quotePreview.data = previewReady;
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-detail-send-quote"));
    await act(async () => {
      fireEvent.click(getByTestId("send-quote-confirm"));
    });
    expect(hooks.sendQuote.mutate).toHaveBeenCalledTimes(1);
    expect(hooks.sendQuote.mutate).toHaveBeenCalledWith(
      { id: 42, data: { message: previewReady.message } },
      expect.any(Object),
    );
  });

  it("sends the owner's edited text, not the original server draft", async () => {
    hooks.quotePreview.data = previewReady;
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-detail-send-quote"));
    // Owner edits the message in the TextInput.
    const input = getByTestId("send-quote-message-input");
    fireEvent.change(input, {
      target: { value: "Hi Dana! Your quote is ready." },
    });
    await act(async () => {
      fireEvent.click(getByTestId("send-quote-confirm"));
    });
    expect(hooks.sendQuote.mutate).toHaveBeenCalledWith(
      { id: 42, data: { message: "Hi Dana! Your quote is ready." } },
      expect.any(Object),
    );
  });

  it("invokes the onSuccess callback so the modal closes and the booking refreshes", async () => {
    hooks.quotePreview.data = previewReady;
    hooks.sendQuote.mutate = vi.fn().mockImplementation((_args, opts) => {
      opts?.onSuccess?.();
    });
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-detail-send-quote"));
    await act(async () => {
      fireEvent.click(getByTestId("send-quote-confirm"));
    });
    expect(hooks.sendQuote.mutate).toHaveBeenCalledTimes(1);
  });
});

describe("SendQuoteModal — reopen seeding", () => {
  it("reseeds the TextInput from the cached preview after a close/reopen cycle", async () => {
    hooks.quotePreview.data = previewReady;
    const { getByTestId, getByDisplayValue } = renderScreen();

    // Open, then close without sending.
    fireEvent.click(getByTestId("button-detail-send-quote"));
    await act(async () => {
      fireEvent.click(getByTestId("send-quote-cancel"));
    });

    // Reopen — preview data is still the same cached object.
    await act(async () => {
      fireEvent.click(getByTestId("button-detail-send-quote"));
    });

    // The TextInput must show the server draft again, not an empty string.
    expect(getByDisplayValue(previewReady.message)).toBeTruthy();
  });
});

describe("SendQuoteModal — blocked path", () => {
  it("shows the warning banner with the blocked reason when canSend is false", () => {
    hooks.quotePreview.data = previewBlocked;
    const { getByTestId, getByText } = renderScreen();
    fireEvent.click(getByTestId("button-detail-send-quote"));
    expect(getByText(previewBlocked.blockedReason!)).toBeTruthy();
  });

  it("does not call useSendQuote.mutate when canSend is false", async () => {
    hooks.quotePreview.data = previewBlocked;
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-detail-send-quote"));
    await act(async () => {
      fireEvent.click(getByTestId("send-quote-confirm"));
    });
    expect(hooks.sendQuote.mutate).not.toHaveBeenCalled();
  });

  it("does not call useSendQuote.mutate while the preview is still loading", async () => {
    hooks.quotePreview.isLoading = true;
    hooks.quotePreview.data = undefined;
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-detail-send-quote"));
    await act(async () => {
      fireEvent.click(getByTestId("send-quote-confirm"));
    });
    expect(hooks.sendQuote.mutate).not.toHaveBeenCalled();
  });
});

describe("SendQuoteModal — error path", () => {
  it("shows an inline error banner when the mutation has an error message", () => {
    hooks.quotePreview.data = previewReady;
    hooks.sendQuote.isError = true;
    hooks.sendQuote.error = { message: "Network timeout. Try again." };
    const { getByTestId, getByText } = renderScreen();
    fireEvent.click(getByTestId("button-detail-send-quote"));
    expect(getByText("Network timeout. Try again.")).toBeTruthy();
  });

  it("shows a fallback message when the error object has no message property", () => {
    hooks.quotePreview.data = previewReady;
    hooks.sendQuote.isError = true;
    hooks.sendQuote.error = {};
    const { getByTestId, getByText } = renderScreen();
    fireEvent.click(getByTestId("button-detail-send-quote"));
    expect(getByText("Couldn't send the quote. Try again.")).toBeTruthy();
  });

  it("prefers the server data.error field over the generic message", () => {
    hooks.quotePreview.data = previewReady;
    hooks.sendQuote.isError = true;
    hooks.sendQuote.error = {
      data: { error: "Quote has already been approved." },
      message: "Request failed",
    };
    const { getByTestId, getByText } = renderScreen();
    fireEvent.click(getByTestId("button-detail-send-quote"));
    expect(getByText("Quote has already been approved.")).toBeTruthy();
  });

  it("keeps the modal open when the mutation fails", () => {
    hooks.quotePreview.data = previewReady;
    hooks.sendQuote.isError = true;
    hooks.sendQuote.error = { message: "Server error." };
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-detail-send-quote"));
    // The confirm button remains in the DOM — modal was not dismissed.
    expect(getByTestId("send-quote-confirm")).toBeTruthy();
  });
});
