// @vitest-environment jsdom
/**
 * Owner-authenticated address editing from the schedule detail panel.
 *
 * A unit/suite is optional, but it is still part of the customer's address:
 * it must survive a save and a fresh booking response, and clearing it must
 * reach the API as null rather than leaving the old value behind.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", () => ({
  useGetBooking: () => hooks.booking,
  useGetCompany: () => hooks.company,
  useGetCurrentUser: () => hooks.me,
  useUpdateBooking: () => hooks.update,
  useApproveBooking: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  getGetBookingQueryKey: (id: number) => ["/api/bookings", id],
  getListBookingsQueryKey: () => ["/api/bookings"],
  bookingDisplayName: (booking: { customerName: string }) =>
    booking.customerName,
}));

vi.mock("@/components/AddressAutocomplete", () => ({
  AddressAutocomplete: (props: {
    id?: string;
    testId?: string;
    value: string;
    onChange: (value: string) => void;
  }) => (
    <input
      id={props.id}
      data-testid={props.testId}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const hooks = vi.hoisted(() => ({
  me: { data: { role: "owner" } },
  company: { data: { timezone: "America/Edmonton" } },
  booking: { data: undefined as unknown },
  update: { mutate: vi.fn(), isPending: false },
}));

const baseBooking = {
  id: 42,
  customerName: "Jane Smith",
  customerPhone: "780-555-0100",
  customerEmail: null,
  customerAddress: "123 Main St",
  addressLine2: null as string | null,
  addressCity: "Edmonton",
  addressProvince: "AB",
  addressPostal: "T5A 0A1",
  service: "Deep Clean",
  scheduledFor: "2026-09-15T16:00:00.000Z",
  status: "confirmed",
  crew: [],
  quotedAmount: null,
  durationMinutes: 120,
  bedrooms: null,
  bathrooms: null,
  frequency: null,
  internalNotes: null,
  jobberCreatedJobId: null,
  jobberQuoteId: null,
  clientApprovedAt: null,
  quoteApprovedAt: null,
  clientApprovedBy: null,
  jobberSynced: false,
  jobberSyncError: null,
};

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BookingDetailPanel bookingId={42} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

import { BookingDetailPanel } from "./BookingDetailPanel";

beforeEach(() => {
  hooks.booking.data = { ...baseBooking, addressLine2: null };
  hooks.update.mutate = vi.fn();
  hooks.update.isPending = false;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("owner address unit line in the booking detail panel", () => {
  it("saves, reloads, and clears a unit line", async () => {
    const view = renderPanel();

    fireEvent.click(view.getByTestId("button-edit-address"));
    const unitInput = view.getByTestId("input-detail-address-line-2");
    fireEvent.change(unitInput, { target: { value: "Suite 5" } });
    await act(async () => {
      fireEvent.click(view.getByTestId("button-save-address"));
    });

    const [firstRequest, firstOptions] = hooks.update.mutate.mock.calls[0]!;
    expect(firstRequest).toEqual({
      id: 42,
      data: expect.objectContaining({ addressLine2: "Suite 5" }),
    });
    await act(async () => firstOptions.onSuccess());

    // The next response represents a reload/refetch after the save.
    hooks.booking.data = { ...baseBooking, addressLine2: "Suite 5" };
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <BookingDetailPanel bookingId={42} onClose={() => {}} />
      </QueryClientProvider>,
    );
    fireEvent.click(view.getByTestId("button-edit-address"));
    expect(
      (view.getByTestId("input-detail-address-line-2") as HTMLInputElement)
        .value,
    ).toBe("Suite 5");

    fireEvent.change(view.getByTestId("input-detail-address-line-2"), {
      target: { value: "" },
    });
    await act(async () => {
      fireEvent.click(view.getByTestId("button-save-address"));
    });

    const [secondRequest] = hooks.update.mutate.mock.calls[1]!;
    expect(secondRequest).toEqual({
      id: 42,
      data: expect.objectContaining({ addressLine2: null }),
    });
  });
});
