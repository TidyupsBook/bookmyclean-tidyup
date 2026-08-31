// @vitest-environment jsdom
/**
 * The web dashboard's "Edit & reschedule" form must resolve an ambiguous
 * fall-back hour the same way the pure zonedInputToIso helper (see
 * lib/time.test.ts) and the mobile app's booking-detail edit screen do: the
 * earlier, still-daylight-saving pass.
 *
 * On 2026-11-01 in America/New_York, clocks fall back from 1:59:59 AM EDT to
 * 1:00:00 AM EST, so the wall clock "01:30 AM" happens twice that morning.
 * There is no UI to pick "first" or "second" occurrence, so the dispatcher
 * must land on a single, predictable instant — and that instant must be what
 * the saved booking, its reopened detail view, and a freshly reopened edit
 * form all agree on.
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
import { formatZoned, isoToZonedInput } from "@/lib/time";

function query(data?: unknown) {
  return { data, isLoading: false };
}
function mutation() {
  return { mutate: vi.fn(), isPending: false };
}

const updateMutate = vi.fn();

function booking(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    customerName: `Customer ${id}`,
    customerPhone: "555-0100",
    customerAddress: "12 Main St",
    service: "Deep clean",
    // Oct 31 at 6:30 PM EDT — safely before the fall-back transition.
    scheduledFor: "2026-10-31T22:30:00.000Z",
    status: "pending",
    crew: [],
    quoteTotals: null,
    quoteSentTotals: null,
    jobberSynced: true,
    jobberQuoteId: "quo_1",
    ...overrides,
  };
}

let bookingsFixture: ReturnType<typeof booking>[] = [];
let companyFixture: Record<string, unknown> = {};

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  // Keep the hand-written helpers (bookingDisplayName, missingBookingFields,
  // ...) real — they are pure functions the components under test lean on.
  ...(await importOriginal<Record<string, unknown>>()),
  useListBookings: () => query(bookingsFixture),
  useUpdateBooking: () => ({ mutate: updateMutate, isPending: false }),
  useCreateBooking: mutation,
  useSyncBookingToJobber: mutation,
  useCreateBookingInvoice: mutation,
  useApproveBooking: () => ({ mutate: vi.fn(), isPending: false }),
  useGetCompany: () => query(companyFixture),
  useGetQuotePreview: () => query(undefined),
  useSendQuote: mutation,
  useSetBookingCrew: mutation,
  useListTeamMembers: () => query([]),
  useGetCurrentUser: () => query({ id: 1, name: "Pat", role: "owner" }),
  getListBookingsQueryKey: () => ["/api/bookings"],
  getGetQuotePreviewQueryKey: () => ["/api/quote-preview"],
}));

vi.mock("@/components/layout/AppLayout", () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/components/JobberSyncButton", () => ({
  JobberSyncButton: () => null,
}));
vi.mock("@/components/JobTimerPanel", () => ({ JobTimerPanel: () => null }));
vi.mock("@/components/PhoneActions", () => ({ PhoneActions: () => null }));
vi.mock("@/components/QuoteCalculator", () => ({
  QuoteCalculator: () => null,
  emptyQuoteDraft: {
    hours: null,
    crewLabel: null,
    hourlyRate: null,
    fuelSurcharge: null,
    discountAmount: null,
    referralSource: null,
    deposit: null,
  },
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { BookingsPage } from "./bookings";

const TIMEZONE = "America/New_York";

function setup(bookings: ReturnType<typeof booking>[]) {
  bookingsFixture = bookings;
  companyFixture = {
    id: 1,
    name: "Sparkle Co",
    timezone: TIMEZONE,
    jobberConnected: true,
    jobberNeedsReauth: false,
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BookingsPage />
    </QueryClientProvider>,
  );
}

/** The datetime-local box has no data-testid, but its label does. */
function schedulingInput(): HTMLInputElement {
  return document.getElementById("b-when") as HTMLInputElement;
}

afterEach(() => {
  updateMutate.mockReset();
  cleanup();
});

describe("Rescheduling into the repeated fall-back hour from the Bookings page", () => {
  it("resolves to the first (daylight) pass, and the dashboard agrees with itself afterward", async () => {
    setup([booking(1)]);

    // Starting point, before any edit: 6:30 PM the evening before.
    fireEvent.click(screen.getByTestId("card-booking-1"));
    expect(screen.getByTestId("dialog-booking-detail").textContent).toContain(
      formatZoned("2026-10-31T22:30:00.000Z", TIMEZONE),
    );

    fireEvent.click(screen.getByTestId("button-detail-edit"));
    const input = schedulingInput();
    expect(input.value).toBe(
      isoToZonedInput("2026-10-31T22:30:00.000Z", TIMEZONE),
    );

    // Type the ambiguous wall clock straight into the datetime-local box.
    fireEvent.change(input, { target: { value: "2026-11-01T01:30" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    });

    expect(updateMutate).toHaveBeenCalledTimes(1);
    const [request, callbacks] = updateMutate.mock.calls[0]!;
    expect(request).toEqual({
      id: 1,
      data: expect.objectContaining({
        // 01:30 in the repeated hour resolves to the EDT (UTC-4) pass, i.e.
        // 05:30 UTC — not the EST (UTC-5) pass an hour later.
        scheduledFor: "2026-11-01T05:30:00.000Z",
      }),
    });

    // Persist the change, the way the server would, and let the save
    // complete.
    bookingsFixture = [booking(1, { scheduledFor: request.data.scheduledFor })];
    await act(async () => callbacks.onSuccess());
    cleanup();

    // Reopen a fresh copy of the dashboard, as if navigating back to it. The
    // detail view and a freshly opened edit form must both show the same
    // wall clock the dispatcher typed, not an hour-shifted neighbour from
    // the other DST offset.
    setup(bookingsFixture);

    fireEvent.click(screen.getByTestId("card-booking-1"));
    const dialogText = screen.getByTestId("dialog-booking-detail").textContent;
    expect(dialogText).toContain(
      formatZoned(request.data.scheduledFor, TIMEZONE),
    );
    expect(dialogText).not.toContain(
      formatZoned("2026-10-31T22:30:00.000Z", TIMEZONE),
    );

    fireEvent.click(screen.getByTestId("button-detail-edit"));
    expect(schedulingInput().value).toBe("2026-11-01T01:30");
  });
});
