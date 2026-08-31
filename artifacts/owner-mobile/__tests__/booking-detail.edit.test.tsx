// @vitest-environment jsdom
/**
 * Edit / Reschedule flow on the booking detail screen.
 *
 * Tapping "Edit / Reschedule" opens a full-screen modal prefilled from the
 * booking's current values (schedule, address, service, notes). Saving calls
 * useUpdateBooking.mutate. Because the modal is conditionally rendered — only
 * mounted when open — every time it opens it picks up the latest booking prop,
 * so a second open after a successful save shows the updated values, not the
 * stale pre-save ones. The final regression also covers the map-pin path:
 * returning from the map must display the fresh direct-by-id booking time.
 *
 * NOTE: The edit modal is conditionally rendered when the owner opens it, so
 * tests must click the trigger button before interacting with modal content.
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
      timezone: "America/Edmonton",
      jobberConnected: false,
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
  update: {
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null as unknown,
    reset: vi.fn(),
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
  team: { data: [] as unknown },
  services: {
    data: [{ name: "Deep Clean" }, { name: "Standard Clean" }] as unknown,
  },
  quotePreview: { data: null as unknown, isLoading: false },
  sendQuote: { mutate: vi.fn(), isPending: false, isError: false },
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetCurrentUser: () => hooks.me,
  useGetCompany: () => hooks.company,
  useGetBooking: () => hooks.booking,
  useUpdateBooking: () => hooks.update,
  useSetBookingCrew: () => hooks.setCrew,
  useApproveBooking: () => hooks.approve,
  useSyncBookingToJobber: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useListTeamMembers: () => hooks.team,
  useListServices: () => hooks.services,
  useGetQuotePreview: () => hooks.quotePreview,
  useSendQuote: () => hooks.sendQuote,
  bookingDisplayName: (b: { customerName?: string; customerPhone?: string }) =>
    b.customerName || b.customerPhone || "Unknown",
  isBookingFieldRequired: (required: string[] | undefined, key: string) =>
    (required ?? []).includes(key),
  missingBookingFields: (
    required: string[] | undefined,
    values: Record<string, string | null | undefined>,
  ) =>
    ["name", "phone"]
      .filter((key) => (required ?? []).includes(key) && !values[key]?.trim())
      .map((key) => key),
  getListBookingsQueryKey: () => ["/bookings"],
  getGetBookingQueryKey: (id: number) => ["/bookings", id],
  getGetQuotePreviewQueryKey: (id: number) => ["/quote-preview", id],
}));

import BookingDetailScreen from "@/app/booking/[id]";

// --- Fixtures ---------------------------------------------------------------

const baseBooking = {
  id: 42,
  customerName: "Jane Smith",
  customerPhone: "780-555-0100",
  customerAddress: "123 Main St",
  addressCity: "Edmonton",
  addressProvince: "AB",
  addressPostal: "T5A 0A1",
  service: "Deep Clean",
  bedrooms: 3,
  bathrooms: 2,
  status: "confirmed" as const,
  // 2026-09-15 at 10:00 AM Mountain time (UTC-6) = 16:00 UTC
  scheduledFor: "2026-09-15T16:00:00.000Z",
  jobberSynced: true,
  jobberSyncError: null,
  jobberCreatedJobId: "jj_1",
  clientApprovedAt: "2026-09-01T12:00:00.000Z",
  crew: [],
  quoteTotals: null,
  quoteSentTotals: null,
  quoteNotes: "Bring extra supplies",
  depositPaidAt: null,
  depositPaidAmount: null,
};

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <BookingDetailScreen />
    </QueryClientProvider>,
  );
  return Object.assign(view, { queryClient: qc });
}

beforeEach(() => {
  hooks.me.data = { role: "owner", teamMemberId: null };
  hooks.company.data = {
    timezone: "America/Edmonton",
    jobberConnected: false,
    jobberNeedsReauth: false,
    bookingRequiredFields: [],
  };
  hooks.update.mutate = vi.fn();
  hooks.update.isPending = false;
  hooks.update.isError = false;
  hooks.update.error = null;
  hooks.setCrew.mutate = vi.fn();
  hooks.setCrew.mutateAsync = vi.fn().mockResolvedValue({});
  hooks.approve.mutate = vi.fn();
  hooks.services.data = [{ name: "Deep Clean" }, { name: "Standard Clean" }];
  hooks.quotePreview.data = null;
  hooks.sendQuote.mutate = vi.fn();
  hooks.team.data = [];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// --- Tests ------------------------------------------------------------------

describe("Edit / Reschedule button visibility", () => {
  it("shows the Edit / Reschedule button for an active booking", () => {
    hooks.booking.data = baseBooking;
    const { getByTestId } = renderScreen();
    expect(getByTestId("button-detail-edit")).toBeTruthy();
  });

  it("hides the Edit button for a completed booking", () => {
    hooks.booking.data = { ...baseBooking, status: "completed" };
    const { queryByTestId } = renderScreen();
    expect(queryByTestId("button-detail-edit")).toBeNull();
  });

  it("hides the Edit button for a canceled booking", () => {
    hooks.booking.data = { ...baseBooking, status: "canceled" };
    const { queryByTestId } = renderScreen();
    expect(queryByTestId("button-detail-edit")).toBeNull();
  });

  it("does not show the Edit button to a cleaner", () => {
    hooks.me.data = { role: "cleaner", teamMemberId: 5 };
    hooks.booking.data = baseBooking;
    const { queryByTestId } = renderScreen();
    expect(queryByTestId("button-detail-edit")).toBeNull();
  });
});

describe("Edit modal prefill from booking values", () => {
  it("prefills the date and time from the booking's scheduledFor in company timezone", () => {
    hooks.booking.data = baseBooking;
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-detail-edit"));

    // America/Edmonton is UTC-6. 2026-09-15T16:00:00Z → 10:00 local
    const dateInput = getByTestId("edit-input-date") as HTMLInputElement;
    const timeInput = getByTestId("edit-input-time") as HTMLInputElement;
    expect(dateInput.value).toBe("2026-09-15");
    expect(timeInput.value).toBe("10:00");
  });

  it("prefills street address from the booking", () => {
    hooks.booking.data = baseBooking;
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-detail-edit"));
    const streetInput = getByTestId("edit-input-street") as HTMLInputElement;
    expect(streetInput.value).toBe("123 Main St");
  });

  it("prefills customer name and phone from the booking", () => {
    hooks.booking.data = baseBooking;
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-detail-edit"));

    expect((getByTestId("edit-input-name") as HTMLInputElement).value).toBe(
      "Jane Smith",
    );
    expect((getByTestId("edit-input-phone") as HTMLInputElement).value).toBe(
      "780-555-0100",
    );
  });

  it("saves, reloads, and clears the optional unit line", async () => {
    hooks.booking.data = { ...baseBooking, addressLine2: null };
    const view = renderScreen();
    fireEvent.click(view.getByTestId("button-detail-edit"));
    fireEvent.change(view.getByTestId("edit-input-address-line-2"), {
      target: { value: "Suite 5" },
    });

    await act(async () => {
      fireEvent.click(view.getByTestId("edit-booking-save"));
    });

    const [firstRequest, firstOptions] = hooks.update.mutate.mock.calls[0]!;
    expect(firstRequest).toEqual({
      id: 42,
      data: expect.objectContaining({ addressLine2: "Suite 5" }),
    });
    await act(async () => firstOptions.onSuccess());

    // Simulate the fresh booking returned after leaving and reopening the
    // screen: the unit value must come from the server response.
    hooks.booking.data = { ...baseBooking, addressLine2: "Suite 5" };
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <BookingDetailScreen />
      </QueryClientProvider>,
    );
    fireEvent.click(view.getByTestId("button-detail-edit"));
    expect(
      (view.getByTestId("edit-input-address-line-2") as HTMLInputElement).value,
    ).toBe("Suite 5");

    fireEvent.change(view.getByTestId("edit-input-address-line-2"), {
      target: { value: "" },
    });
    await act(async () => {
      fireEvent.click(view.getByTestId("edit-booking-save"));
    });

    const [secondRequest] = hooks.update.mutate.mock.calls[1]!;
    expect(secondRequest).toEqual({
      id: 42,
      data: expect.objectContaining({ addressLine2: null }),
    });
  });

  it("prefills service from the booking", () => {
    hooks.booking.data = baseBooking;
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-detail-edit"));
    const serviceInput = getByTestId("edit-input-service") as HTMLInputElement;
    expect(serviceInput.value).toBe("Deep Clean");
  });

  it("prefills notes from booking.quoteNotes when internalNotes is absent", () => {
    hooks.booking.data = baseBooking;
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-detail-edit"));
    const notesInput = getByTestId("edit-input-notes") as HTMLInputElement;
    expect(notesInput.value).toBe("Bring extra supplies");
  });
});

describe("Edit modal save", () => {
  it("calls useUpdateBooking.mutate with the edited values", async () => {
    hooks.booking.data = baseBooking;
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-detail-edit"));

    // Change the service
    fireEvent.change(getByTestId("edit-input-service"), {
      target: { value: "Standard Clean" },
    });

    await act(async () => {
      fireEvent.click(getByTestId("edit-booking-save"));
    });

    expect(hooks.update.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 42,
        data: expect.objectContaining({ service: "Standard Clean" }),
      }),
      expect.any(Object),
    );
  });

  it("sends edited customer name and phone in the update payload", async () => {
    hooks.booking.data = baseBooking;
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-detail-edit"));
    fireEvent.change(getByTestId("edit-input-name"), {
      target: { value: "Janet Smith" },
    });
    fireEvent.change(getByTestId("edit-input-phone"), {
      target: { value: "780-555-0199" },
    });

    await act(async () => {
      fireEvent.click(getByTestId("edit-booking-save"));
    });

    expect(hooks.update.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 42,
        data: expect.objectContaining({
          customerName: "Janet Smith",
          customerPhone: "780-555-0199",
        }),
      }),
      expect.any(Object),
    );
  });

  it("blocks clearing a required phone before sending the update", async () => {
    hooks.company.data = {
      timezone: "America/Edmonton",
      jobberConnected: false,
      jobberNeedsReauth: false,
      bookingRequiredFields: ["phone"],
    };
    hooks.booking.data = baseBooking;
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-detail-edit"));
    fireEvent.change(getByTestId("edit-input-phone"), {
      target: { value: " " },
    });

    await act(async () => {
      fireEvent.click(getByTestId("edit-booking-save"));
    });

    expect(getByTestId("edit-form-error").textContent).toContain(
      "Still needs phone",
    );
    expect(hooks.update.mutate).not.toHaveBeenCalled();
  });

  it("shows a validation error when the date is blank", async () => {
    hooks.booking.data = baseBooking;
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-detail-edit"));

    fireEvent.change(getByTestId("edit-input-date"), {
      target: { value: "" },
    });

    await act(async () => {
      fireEvent.click(getByTestId("edit-booking-save"));
    });

    expect(getByTestId("edit-form-error")).toBeTruthy();
    expect(hooks.update.mutate).not.toHaveBeenCalled();
  });

  it("persists a newly set deposit when the booking is reopened", async () => {
    hooks.booking.data = { ...baseBooking, quoteDeposit: null };
    const view = renderScreen();
    fireEvent.click(view.getByTestId("button-detail-edit"));
    fireEvent.change(view.getByTestId("edit-input-quote-deposit"), {
      target: { value: "125.50" },
    });

    await act(async () => {
      fireEvent.click(view.getByTestId("edit-booking-save"));
    });

    const [request, callbacks] = hooks.update.mutate.mock.calls[0];
    expect(request.data.quoteDeposit).toBe(125.5);

    await act(async () => {
      callbacks.onSuccess();
    });

    // The refetch after save returns the persisted server value. Re-rendering
    // with that response simulates leaving and reopening the booking.
    hooks.booking.data = { ...baseBooking, quoteDeposit: 125.5 };
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <BookingDetailScreen />
      </QueryClientProvider>,
    );
    fireEvent.click(view.getByTestId("button-detail-edit"));

    expect(
      (view.getByTestId("edit-input-quote-deposit") as HTMLInputElement).value,
    ).toBe("125.5");
  });

  it("persists clearing a deposit as no deposit when reopened", async () => {
    hooks.booking.data = { ...baseBooking, quoteDeposit: 80 };
    const view = renderScreen();
    fireEvent.click(view.getByTestId("button-detail-edit"));
    fireEvent.change(view.getByTestId("edit-input-quote-deposit"), {
      target: { value: "" },
    });

    await act(async () => {
      fireEvent.click(view.getByTestId("edit-booking-save"));
    });

    const [request, callbacks] = hooks.update.mutate.mock.calls[0];
    expect(request.data.quoteDeposit).toBeNull();

    await act(async () => {
      callbacks.onSuccess();
    });

    hooks.booking.data = { ...baseBooking, quoteDeposit: null };
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <BookingDetailScreen />
      </QueryClientProvider>,
    );
    fireEvent.click(view.getByTestId("button-detail-edit"));

    expect(
      (view.getByTestId("edit-input-quote-deposit") as HTMLInputElement).value,
    ).toBe("");
  });

  it("does not overwrite a paid deposit while editing the quoted deposit", async () => {
    hooks.booking.data = {
      ...baseBooking,
      quoteDeposit: 100,
      depositPaidAt: "2026-09-02T12:00:00.000Z",
      depositPaidAmount: 100,
    };
    const view = renderScreen();
    fireEvent.click(view.getByTestId("button-detail-edit"));
    fireEvent.change(view.getByTestId("edit-input-quote-deposit"), {
      target: { value: "150" },
    });

    await act(async () => {
      fireEvent.click(view.getByTestId("edit-booking-save"));
    });

    const [request] = hooks.update.mutate.mock.calls[0];
    expect(request.data.quoteDeposit).toBe(150);
    expect(request.data).not.toHaveProperty("depositPaidAt");
    expect(request.data).not.toHaveProperty("depositPaidAmount");

    // A fresh booking response keeps the historical payment untouched; the
    // editable quote amount is allowed to change independently.
    hooks.booking.data = {
      ...baseBooking,
      quoteDeposit: 150,
      depositPaidAt: "2026-09-02T12:00:00.000Z",
      depositPaidAmount: 100,
    };
    await act(async () => {
      hooks.update.mutate.mock.calls[0][1].onSuccess();
    });
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <BookingDetailScreen />
      </QueryClientProvider>,
    );

    const refreshedBooking = hooks.booking.data as unknown as {
      quoteDeposit: number;
      depositPaidAt: string;
      depositPaidAmount: number;
    };
    expect(refreshedBooking.depositPaidAmount).toBe(100);
    expect(refreshedBooking.depositPaidAt).toBe("2026-09-02T12:00:00.000Z");
  });
});

describe("Edit modal prefill stays fresh on reopen after booking changes", () => {
  it("shows updated values after the booking prop changes between opens", async () => {
    hooks.booking.data = baseBooking;
    const { getByTestId, rerender } = renderScreen();

    // First open — verify original values
    fireEvent.click(getByTestId("button-detail-edit"));
    expect((getByTestId("edit-input-service") as HTMLInputElement).value).toBe(
      "Deep Clean",
    );

    // Close the modal
    fireEvent.click(getByTestId("edit-booking-back"));

    // Booking data "refreshes" with a new service
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    hooks.booking.data = { ...baseBooking, service: "Standard Clean" };
    rerender(
      <QueryClientProvider client={qc}>
        <BookingDetailScreen />
      </QueryClientProvider>,
    );

    // Reopen — must pick up the fresh booking service
    fireEvent.click(getByTestId("button-detail-edit"));
    expect((getByTestId("edit-input-service") as HTMLInputElement).value).toBe(
      "Standard Clean",
    );
  });
});

describe("Map pin → reschedule → reopen freshness", () => {
  it("shows the updated company-local time when reopening a booking from its map pin", async () => {
    hooks.booking.data = baseBooking;
    const view = renderScreen();
    const invalidateQueries = vi.spyOn(view.queryClient, "invalidateQueries");

    // This is the time the owner sees after opening the pin for the first time.
    expect(view.getByText("Tue, Sep 15 · 10:00 AM")).toBeTruthy();

    fireEvent.click(view.getByTestId("button-detail-edit"));
    fireEvent.change(view.getByTestId("edit-input-time"), {
      target: { value: "14:30" },
    });

    await act(async () => {
      fireEvent.click(view.getByTestId("edit-booking-save"));
    });

    const [request, callbacks] = hooks.update.mutate.mock.calls[0]!;
    expect(request).toEqual({
      id: 42,
      data: expect.objectContaining({
        // 14:30 in America/Edmonton on this date is 20:30 UTC.
        scheduledFor: "2026-09-15T20:30:00.000Z",
      }),
    });

    await act(async () => {
      callbacks.onSuccess();
    });

    // The list backing the map and the direct booking query must both be
    // invalidated. The latter is what makes reopening the pin authoritative
    // even if the map's summary still contains the old time.
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["/bookings"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["/bookings", 42],
    });

    // Simulate returning to the map, tapping the same pin, and receiving the
    // fresh direct-by-id response while the old map summary is still stale.
    hooks.booking.data = {
      ...baseBooking,
      scheduledFor: request.data.scheduledFor,
    };
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <BookingDetailScreen />
      </QueryClientProvider>,
    );

    expect(view.queryByText("Tue, Sep 15 · 10:00 AM")).toBeNull();
    expect(view.getByText("Tue, Sep 15 · 2:30 PM")).toBeTruthy();
  });
});

describe("Timezone-boundary rescheduling", () => {
  it("keeps the intended company-local date across UTC midnight", async () => {
    hooks.company.data = {
      timezone: "America/Los_Angeles",
      jobberConnected: false,
      jobberNeedsReauth: false,
      bookingRequiredFields: [],
    };
    hooks.booking.data = {
      ...baseBooking,
      // Aug 5 at 11:30 PM in Los Angeles, but Aug 6 in UTC.
      scheduledFor: "2026-08-06T06:30:00.000Z",
    };
    const view = renderScreen();

    expect(view.getByText("Wed, Aug 5 · 11:30 PM")).toBeTruthy();
    fireEvent.click(view.getByTestId("button-detail-edit"));
    expect(
      (view.getByTestId("edit-input-date") as HTMLInputElement).value,
    ).toBe("2026-08-05");
    expect(
      (view.getByTestId("edit-input-time") as HTMLInputElement).value,
    ).toBe("23:30");

    fireEvent.change(view.getByTestId("edit-input-date"), {
      target: { value: "2026-08-06" },
    });
    fireEvent.change(view.getByTestId("edit-input-time"), {
      target: { value: "00:15" },
    });
    await act(async () => {
      fireEvent.click(view.getByTestId("edit-booking-save"));
    });

    const [request, callbacks] = hooks.update.mutate.mock.calls[0]!;
    expect(request.data.scheduledFor).toBe("2026-08-06T07:15:00.000Z");
    await act(async () => callbacks.onSuccess());

    // Reopening after the server returns the saved instant must keep the
    // company-local date and time, rather than displaying the UTC date.
    hooks.booking.data = {
      ...baseBooking,
      scheduledFor: request.data.scheduledFor,
    };
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <BookingDetailScreen />
      </QueryClientProvider>,
    );
    expect(view.queryByText("Wed, Aug 5 · 11:30 PM")).toBeNull();
    expect(view.getByText("Thu, Aug 6 · 12:15 AM")).toBeTruthy();

    fireEvent.click(view.getByTestId("button-detail-edit"));
    expect(
      (view.getByTestId("edit-input-date") as HTMLInputElement).value,
    ).toBe("2026-08-06");
    expect(
      (view.getByTestId("edit-input-time") as HTMLInputElement).value,
    ).toBe("00:15");
  });

  it("keeps the intended company-local time across spring-forward", async () => {
    hooks.company.data = {
      timezone: "America/New_York",
      jobberConnected: false,
      jobberNeedsReauth: false,
      bookingRequiredFields: [],
    };
    hooks.booking.data = {
      ...baseBooking,
      // Mar 8 at 1:30 AM EST; the next valid target below is after the
      // skipped 2:00–2:59 AM hour.
      scheduledFor: "2026-03-08T06:30:00.000Z",
    };
    const view = renderScreen();

    expect(view.getByText("Sun, Mar 8 · 1:30 AM")).toBeTruthy();
    fireEvent.click(view.getByTestId("button-detail-edit"));
    expect(
      (view.getByTestId("edit-input-date") as HTMLInputElement).value,
    ).toBe("2026-03-08");
    expect(
      (view.getByTestId("edit-input-time") as HTMLInputElement).value,
    ).toBe("01:30");

    fireEvent.change(view.getByTestId("edit-input-time"), {
      target: { value: "03:30" },
    });
    await act(async () => {
      fireEvent.click(view.getByTestId("edit-booking-save"));
    });

    const [request, callbacks] = hooks.update.mutate.mock.calls[0]!;
    expect(request.data.scheduledFor).toBe("2026-03-08T07:30:00.000Z");
    await act(async () => callbacks.onSuccess());

    hooks.booking.data = {
      ...baseBooking,
      scheduledFor: request.data.scheduledFor,
    };
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <BookingDetailScreen />
      </QueryClientProvider>,
    );
    expect(view.queryByText("Sun, Mar 8 · 1:30 AM")).toBeNull();
    expect(view.getByText("Sun, Mar 8 · 3:30 AM")).toBeTruthy();

    fireEvent.click(view.getByTestId("button-detail-edit"));
    expect(
      (view.getByTestId("edit-input-date") as HTMLInputElement).value,
    ).toBe("2026-03-08");
    expect(
      (view.getByTestId("edit-input-time") as HTMLInputElement).value,
    ).toBe("03:30");
  });

  it("resolves a reschedule into the repeated fall-back hour to the first (daylight) pass", async () => {
    // 2026-11-01 is fall-back in America/New_York: clocks go from 1:59:59 AM
    // EDT back to 1:00:00 AM EST, so the wall clock "01:30 AM" happens twice
    // that morning. There is no UI to pick "first" or "second" occurrence, so
    // the owner must land on a single, predictable instant: the earlier,
    // still-daylight-saving pass (EDT, UTC-4).
    hooks.company.data = {
      timezone: "America/New_York",
      jobberConnected: false,
      jobberNeedsReauth: false,
      bookingRequiredFields: [],
    };
    hooks.booking.data = {
      ...baseBooking,
      // Oct 31 at 6:30 PM EDT — safely before the fall-back transition.
      scheduledFor: "2026-10-31T22:30:00.000Z",
    };
    const view = renderScreen();

    expect(view.getByText("Sat, Oct 31 · 6:30 PM")).toBeTruthy();
    fireEvent.click(view.getByTestId("button-detail-edit"));
    fireEvent.change(view.getByTestId("edit-input-date"), {
      target: { value: "2026-11-01" },
    });
    fireEvent.change(view.getByTestId("edit-input-time"), {
      target: { value: "01:30" },
    });
    await act(async () => {
      fireEvent.click(view.getByTestId("edit-booking-save"));
    });

    // 01:30 in the repeated hour resolves to the EDT (UTC-4) pass, i.e.
    // 05:30 UTC — not the EST (UTC-5) pass an hour later.
    const [request, callbacks] = hooks.update.mutate.mock.calls[0]!;
    expect(request).toEqual({
      id: 42,
      data: expect.objectContaining({
        scheduledFor: "2026-11-01T05:30:00.000Z",
      }),
    });
    await act(async () => callbacks.onSuccess());

    // The reopened detail screen must show the same local hour the owner
    // typed, not an hour-shifted neighbour from the other DST offset.
    hooks.booking.data = {
      ...baseBooking,
      scheduledFor: request.data.scheduledFor,
    };
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <BookingDetailScreen />
      </QueryClientProvider>,
    );
    expect(view.queryByText("Sat, Oct 31 · 6:30 PM")).toBeNull();
    expect(view.getByText("Sun, Nov 1 · 1:30 AM")).toBeTruthy();

    // Reopening the edit form itself must also agree — form, saved instant,
    // and detail screen all show the same wall clock.
    fireEvent.click(view.getByTestId("button-detail-edit"));
    expect(
      (view.getByTestId("edit-input-date") as HTMLInputElement).value,
    ).toBe("2026-11-01");
    expect(
      (view.getByTestId("edit-input-time") as HTMLInputElement).value,
    ).toBe("01:30");
  });
});
