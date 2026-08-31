// @vitest-environment jsdom
/**
 * The explicit Create/Adjust quote entry point on the Bookings page.
 *
 * Pricing used to hide behind a small "Adjust price" toggle inside the
 * text-a-quote dialog. These tests pin the new front door: the card (and the
 * detail dialog) offer "Create quote" until a price exists and "Adjust
 * quote" after, entering that way opens the dialog with the calculator
 * already expanded, the plain "Send quote" path still opens collapsed, and
 * saving a price never sends a text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function query(data?: unknown) {
  return { data, isLoading: false };
}
function mutation() {
  return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
}

// Shared spies so a test can tell "the price was saved" from "a text went out".
const updateMutate = vi.fn();
const sendMutate = vi.fn();
let role = "owner";

const pricedTotals = {
  lineItems: [{ name: "Deep clean", quantity: 3, unitPrice: 90 }],
  subtotal: 270,
  taxLabel: "GST",
  taxRate: 0.05,
  taxAmount: 13.5,
  feesLabel: "Fees",
  feesRate: 0,
  feesAmount: 0,
  total: 283.5,
  deposit: 0,
};

function booking(
  id: number,
  customerName: string,
  quoteTotals: typeof pricedTotals | null,
  quotedAmount: number | null = null,
) {
  return {
    id,
    customerName,
    customerPhone: "555-0100",
    customerAddress: "12 Main St",
    service: "Deep clean",
    scheduledFor: "2026-08-20T14:00:00.000Z",
    status: "pending",
    crew: [],
    quoteTotals,
    quotedAmount,
    quoteSentTotals: null,
    quoteSentAt: null,
  };
}

let bookingsCache: ReturnType<typeof booking>[] | null = null;
function bookingsFixture() {
  // Stable identity across renders, like react-query's cached data.
  bookingsCache ??= [
    booking(1, "Ann Alpha", null), // no price yet
    booking(2, "Bo Bravo", pricedTotals), // priced with the calculator
    // Priced flat by the receptionist, calculator never touched — a price
    // all the same, even if totals were somehow absent.
    booking(3, "Cam Charlie", null, 150),
  ];
  return bookingsCache;
}

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  // Keep the hand-written helpers (bookingDisplayName, ...) real.
  ...(await importOriginal<Record<string, unknown>>()),
  useListBookings: () => query(bookingsFixture()),
  useUpdateBooking: () => ({ mutate: updateMutate, isPending: false }),
  useCreateBooking: mutation,
  useSyncBookingToJobber: mutation,
  useCreateBookingInvoice: mutation,
  useApproveBooking: mutation,
  useGetCompany: () =>
    query({ id: 1, name: "Sparkle Co", timezone: "America/Toronto" }),
  useGetQuotePreview: () =>
    query({
      message: "Hi — your cleaning quote",
      canSend: true,
      fromNumber: "+15550001111",
      totals: null,
    }),
  useSendQuote: () => ({ mutate: sendMutate, isPending: false }),
  useSetBookingCrew: mutation,
  useListTeamMembers: () => query([]),
  useGetCurrentUser: () => query({ id: 1, name: "Pat", role }),
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
// A stub calculator that can still dirty the draft, so the Save price
// button arms exactly like it does with the real thing.
vi.mock("@/components/QuoteCalculator", () => ({
  QuoteCalculator: ({
    value,
    onChange,
  }: {
    value: Record<string, unknown>;
    onChange: (next: Record<string, unknown>) => void;
  }) => (
    <div data-testid="quote-calculator">
      <button
        type="button"
        data-testid="calc-set-price"
        onClick={() =>
          onChange({
            ...value,
            hours: 3,
            crewLabel: "2 cleaners",
            hourlyRate: 90,
          })
        }
      >
        set price
      </button>
    </div>
  ),
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

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BookingsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  role = "owner";
  bookingsCache = null;
  updateMutate.mockClear();
  sendMutate.mockClear();
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/bookings");
});

describe("Create/Adjust quote on the booking card", () => {
  it("says Create quote before a price exists and Adjust quote after", () => {
    renderPage();
    expect(screen.getByTestId("button-quote-price-1")).toHaveTextContent(
      "Create quote",
    );
    expect(screen.getByTestId("button-quote-price-2")).toHaveTextContent(
      "Adjust quote",
    );
  });

  it("counts a flat receptionist price as an existing quote", () => {
    renderPage();
    expect(screen.getByTestId("button-quote-price-3")).toHaveTextContent(
      "Adjust quote",
    );
    // And the dialog agrees: no "no price set yet" notice for a priced job.
    fireEvent.click(screen.getByTestId("button-quote-price-3"));
    expect(screen.queryByTestId("text-no-price")).not.toBeInTheDocument();
  });

  it("opens the dialog with the calculator expanded and the save-now, text-later hint", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("button-quote-price-1"));

    expect(screen.getByTestId("quote-calculator")).toBeInTheDocument();
    expect(screen.getByTestId("button-adjust-price")).toHaveTextContent(
      "Hide price adjustments",
    );
    // With no price yet, it says the price can be saved without texting.
    expect(screen.getByTestId("text-no-price")).toHaveTextContent(
      /close this and send it later/,
    );
  });

  it("keeps the Send quote entry collapsed, exactly as before", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("button-send-quote-1"));

    expect(screen.queryByTestId("quote-calculator")).not.toBeInTheDocument();
    expect(screen.getByTestId("button-adjust-price")).toHaveTextContent(
      "Adjust price",
    );
  });

  it("saves the price without sending any text", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("button-quote-price-1"));
    fireEvent.click(screen.getByTestId("calc-set-price"));
    fireEvent.click(screen.getByTestId("button-save-price"));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        data: expect.objectContaining({
          quoteHours: 3,
          quoteCrewLabel: "2 cleaners",
          quoteHourlyRate: 90,
        }),
      }),
      expect.anything(),
    );
    expect(sendMutate).not.toHaveBeenCalled();
  });

  it("hides both quote actions from cleaners", () => {
    role = "cleaner";
    renderPage();
    expect(
      screen.queryByTestId("button-quote-price-1"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("button-send-quote-1")).not.toBeInTheDocument();
  });
});

describe("Create/Adjust quote in the booking detail dialog", () => {
  it("offers the same entry and opens the dialog in pricing mode", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("card-booking-1"));

    const button = screen.getByTestId("button-detail-quote-price");
    expect(button).toHaveTextContent("Create quote");
    fireEvent.click(button);

    expect(screen.getByTestId("quote-calculator")).toBeInTheDocument();
    expect(screen.getByTestId("button-adjust-price")).toHaveTextContent(
      "Hide price adjustments",
    );
  });

  it("labels an already-priced booking Adjust quote", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("card-booking-2"));
    expect(screen.getByTestId("button-detail-quote-price")).toHaveTextContent(
      "Adjust quote",
    );
  });

  it("labels a flat-priced booking Adjust quote too", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("card-booking-3"));
    expect(screen.getByTestId("button-detail-quote-price")).toHaveTextContent(
      "Adjust quote",
    );
  });
});
