// @vitest-environment jsdom
/**
 * The booking card's Jobber section is a chain of ternaries
 * (reauth → sync failed → synced links). These tests pin every branch so a
 * future edit can't silently drop the "View request in Jobber" /
 * "Quote #N in Jobber" links, show them for unsynced bookings, or leak the
 * section to cleaner logins.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function query(data?: unknown) {
  return { data, isLoading: false };
}
function mutation() {
  return { mutate: vi.fn(), isPending: false };
}

type BookingOverrides = Record<string, unknown>;

function booking(id: number, overrides: BookingOverrides = {}) {
  return {
    id,
    customerName: `Customer ${id}`,
    customerPhone: "555-0100",
    customerAddress: "12 Main St",
    service: "Deep clean",
    scheduledFor: "2026-08-10T14:00:00.000Z",
    status: "confirmed",
    crew: [],
    quoteTotals: null,
    quoteSentTotals: null,
    jobberSynced: false,
    ...overrides,
  };
}

// Mutable fixtures so each test can pick the state under test before render.
let bookingsFixture: ReturnType<typeof booking>[] = [];
let companyFixture: Record<string, unknown> = {};
let userFixture: Record<string, unknown> = {};

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  // Keep the hand-written helpers (bookingDisplayName, missingBookingFields,
  // ...) real — they are pure functions the components under test lean on.
  ...(await importOriginal<Record<string, unknown>>()),
  useListBookings: () => query(bookingsFixture),
  useUpdateBooking: mutation,
  useCreateBooking: mutation,
  useSyncBookingToJobber: mutation,
  useCreateBookingInvoice: mutation,
  useApproveBooking: mutation,
  useGetCompany: () => query(companyFixture),
  useGetQuotePreview: () => query(undefined),
  useSendQuote: mutation,
  useSetBookingCrew: mutation,
  useListTeamMembers: () => query([]),
  useGetCurrentUser: () => query(userFixture),
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

function setup({
  bookings,
  company = {},
  user = { id: 1, name: "Pat", role: "owner" },
}: {
  bookings: ReturnType<typeof booking>[];
  company?: Record<string, unknown>;
  user?: Record<string, unknown>;
}) {
  bookingsFixture = bookings;
  companyFixture = {
    id: 1,
    name: "Sparkle Co",
    timezone: "America/Toronto",
    jobberConnected: true,
    jobberNeedsReauth: false,
    ...company,
  };
  userFixture = user;
  const page = renderPage();
  if (user.role !== "cleaner") {
    fireEvent.click(screen.getByTestId("button-queue-scheduled"));
  }
  return page;
}

afterEach(() => {
  cleanup();
});

describe("booking card Jobber section", () => {
  it("shows the persisted sync error and a Sync button for a failed, unsynced booking", () => {
    setup({
      bookings: [
        booking(1, {
          jobberSynced: false,
          jobberSyncError: "Jobber rejected the client email",
          jobberSyncErrorAt: "2026-08-08T12:00:00.000Z",
        }),
      ],
    });

    const error = screen.getByTestId("text-sync-error-1");
    expect(error).toHaveTextContent("Last sync failed:");
    expect(error).toHaveTextContent("Jobber rejected the client email");
    expect(
      screen.getByRole("button", { name: /sync to jobber/i }),
    ).toBeInTheDocument();

    // No links may appear for an unsynced booking.
    expect(screen.queryByTestId("link-jobber-request-1")).toBeNull();
    expect(screen.queryByTestId("link-jobber-quote-1")).toBeNull();
  });

  it("shows only the request link when synced without a quote", () => {
    setup({
      bookings: [
        booking(2, {
          jobberSynced: true,
          jobberWebUri: "https://secure.getjobber.com/requests/42",
        }),
      ],
    });

    const link = screen.getByTestId("link-jobber-request-2");
    expect(link).toHaveAttribute(
      "href",
      "https://secure.getjobber.com/requests/42",
    );
    expect(link).toHaveTextContent("View request in Jobber");
    expect(screen.queryByTestId("link-jobber-quote-2")).toBeNull();
    // Synced bookings don't offer a redundant sync button.
    expect(
      screen.queryByRole("button", { name: /sync to jobber/i }),
    ).toBeNull();
  });

  it("shows request and quote links, with the quote number in the label", () => {
    setup({
      bookings: [
        booking(3, {
          jobberSynced: true,
          jobberWebUri: "https://secure.getjobber.com/requests/42",
          jobberQuoteWebUri: "https://secure.getjobber.com/quotes/77",
          jobberQuoteNumber: 77,
        }),
      ],
    });

    expect(screen.getByTestId("link-jobber-request-3")).toHaveTextContent(
      "View request in Jobber",
    );
    const quote = screen.getByTestId("link-jobber-quote-3");
    expect(quote).toHaveAttribute(
      "href",
      "https://secure.getjobber.com/quotes/77",
    );
    expect(quote).toHaveTextContent("Quote #77 in Jobber");
  });

  it("falls back to a generic quote label when no quote number is stored", () => {
    setup({
      bookings: [
        booking(4, {
          jobberSynced: true,
          jobberQuoteWebUri: "https://secure.getjobber.com/quotes/9",
          jobberQuoteNumber: null,
        }),
      ],
    });

    expect(screen.getByTestId("link-jobber-quote-4")).toHaveTextContent(
      "View quote in Jobber",
    );
  });

  it("offers reconnect instead of sync when Jobber needs reauth", () => {
    setup({
      bookings: [booking(5, { jobberSynced: false })],
      company: { jobberNeedsReauth: true },
    });

    expect(
      screen.getByRole("button", { name: /reconnect jobber to sync/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /sync to jobber/i }),
    ).toBeNull();
  });

  it("hides generic sync for a manual-only failure", () => {
    setup({
      bookings: [
        booking(6, {
          jobberSynced: true,
          jobberSyncError:
            "Could not update this job's Jobber visit: unavailable",
          jobberSyncErrorAt: "2026-08-08T12:00:00.000Z",
          jobberAutomaticRetryStatus: "manual",
          jobberAutomaticRetriesRemaining: null,
          jobberNextRetryAt: null,
        }),
      ],
    });

    expect(screen.getByText(/Automatic retries stopped/)).toBeInTheDocument();
    expect(screen.queryByTestId("button-sync-to-jobber-6")).toBeNull();
  });

  it("keeps sync available for an exhausted bound booking when the primary needs reauth", () => {
    setup({
      bookings: [
        booking(9, {
          jobberSynced: false,
          jobberSyncError: "Jobber is unavailable",
          jobberSyncErrorAt: "2026-08-08T12:00:00.000Z",
          jobberAutomaticRetryStatus: "exhausted",
          jobberAutomaticRetriesRemaining: 0,
          jobberNextRetryAt: null,
          jobberRetryUsesBookingConnection: true,
        }),
      ],
      company: { jobberNeedsReauth: true },
    });

    expect(screen.getByTestId("button-sync-to-jobber-9")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /reconnect jobber to sync/i }),
    ).toBeNull();
  });

  it("offers reconnect for an exhausted primary booking", () => {
    setup({
      bookings: [
        booking(10, {
          jobberSynced: false,
          jobberSyncError: "Jobber is unavailable",
          jobberSyncErrorAt: "2026-08-08T12:00:00.000Z",
          jobberAutomaticRetryStatus: "exhausted",
          jobberAutomaticRetriesRemaining: 0,
          jobberNextRetryAt: null,
          jobberRetryUsesBookingConnection: false,
        }),
      ],
      company: { jobberNeedsReauth: true },
    });

    expect(
      screen.getByRole("button", { name: /reconnect jobber to sync/i }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("button-sync-to-jobber-10")).toBeNull();
  });

  it("links the draft quote as soon as it exists, without waiting for the row to go green", () => {
    // The quote is drafted with the booking now, so gating the link on
    // jobberSynced (or on a quote having been texted) would hide a quote that
    // is sitting in Jobber right now.
    setup({
      bookings: [
        booking(7, {
          jobberSynced: false,
          jobberQuoteWebUri: "https://secure.getjobber.com/quotes/31",
          jobberQuoteNumber: 31,
        }),
      ],
    });

    expect(screen.getByTestId("link-jobber-quote-7")).toHaveTextContent(
      "Quote #31 in Jobber",
    );
  });

  it("keeps the failure and a retry in front of the office when only the quote leg failed", () => {
    // The request landed, so the booking is synced — but something is still
    // wrong, and the old layout showed the error only for unsynced bookings.
    setup({
      bookings: [
        booking(8, {
          jobberSynced: true,
          jobberWebUri: "https://secure.getjobber.com/requests/42",
          jobberSyncError: "Jobber rejected the quote line items",
          jobberSyncErrorAt: "2026-08-10T12:00:00.000Z",
        }),
      ],
    });

    expect(screen.getByTestId("text-sync-error-8")).toHaveTextContent(
      "Jobber rejected the quote line items",
    );
    expect(screen.getByTestId("link-jobber-request-8")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /sync to jobber/i }),
    ).toBeInTheDocument();
  });

  it("renders no Jobber section at all for a cleaner login", () => {
    setup({
      bookings: [
        booking(6, {
          jobberSynced: true,
          jobberWebUri: "https://secure.getjobber.com/requests/42",
          jobberQuoteWebUri: "https://secure.getjobber.com/quotes/77",
          jobberQuoteNumber: 77,
        }),
      ],
      user: { id: 2, name: "Casey", role: "cleaner" },
    });

    expect(screen.queryByTestId("link-jobber-request-6")).toBeNull();
    expect(screen.queryByTestId("link-jobber-quote-6")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /sync to jobber/i }),
    ).toBeNull();
    expect(screen.queryByText(/in jobber/i)).toBeNull();
    // A cleaner's jobs are normally scheduled; dispatch filters must not hide
    // their entire work list when the office gets an Unscheduled default.
    expect(screen.getByTestId("card-booking-6")).toBeInTheDocument();
  });
});
