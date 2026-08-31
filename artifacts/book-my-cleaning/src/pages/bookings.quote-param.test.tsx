// @vitest-environment jsdom
/**
 * Landing on /bookings?quote=<id> — the tail end of "Create quote" from a
 * lead card — must open the Text-a-quote dialog on that booking, and strip
 * the param so a refresh (or closing the dialog) doesn't reopen it. A quote
 * link to a job the list doesn't hold gets the same "that job isn't here"
 * notice as the hash deep link, instead of silently doing nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function query(data?: unknown) {
  return { data, isLoading: false };
}
function mutation() {
  return { mutate: vi.fn(), isPending: false };
}

function booking(id: number, customerName: string) {
  return {
    id,
    customerName,
    customerPhone: "555-0100",
    customerAddress: "12 Main St",
    service: "Deep clean",
    scheduledFor: "2026-08-10T14:00:00.000Z",
    status: "pending",
    crew: [],
    quoteTotals: null,
    quoteSentTotals: null,
  };
}

let bookingsCache: ReturnType<typeof booking>[] | null = null;
function bookingsFixture() {
  // Stable identity across renders, like react-query's cached data — the
  // page's deep-link effects key off the array reference.
  bookingsCache ??= [booking(1, "Ann Alpha"), booking(2, "Bo Bravo")];
  return bookingsCache;
}

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  // Keep the hand-written helpers (bookingDisplayName, ...) real.
  ...(await importOriginal<Record<string, unknown>>()),
  useListBookings: () => query(bookingsFixture()),
  useUpdateBooking: mutation,
  useCreateBooking: mutation,
  useSyncBookingToJobber: mutation,
  useCreateBookingInvoice: mutation,
  useApproveBooking: mutation,
  useGetCompany: () =>
    query({ id: 1, name: "Sparkle Co", timezone: "America/Toronto" }),
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

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/bookings");
});

describe("the ?quote deep link", () => {
  it("opens the Text-a-quote dialog on the named booking and strips the param", () => {
    window.history.replaceState(null, "", "/bookings?quote=2");
    renderPage();

    expect(screen.getByText(/Text a quote to Bo Bravo/)).toBeInTheDocument();
    // Stripped right away, so refresh/close can't reopen it.
    expect(window.location.search).toBe("");
  });

  it("does not open any dialog without the param", () => {
    renderPage();
    expect(screen.queryByText(/Text a quote to/)).not.toBeInTheDocument();
  });

  it("says the job isn't in the list rather than doing nothing", () => {
    window.history.replaceState(null, "", "/bookings?quote=999");
    renderPage();

    expect(screen.queryByText(/Text a quote to/)).not.toBeInTheDocument();
    expect(screen.getByTestId("pre-cutoff-notice")).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });
});
