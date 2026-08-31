// @vitest-environment jsdom
/**
 * The bookings list starts at August 1, 2026 — everything earlier is
 * Jobber-era history and is looked up in Jobber.
 *
 * An empty list therefore rarely means "this company has never had a
 * booking"; far more often it means every job they have is on the other side
 * of the cutoff. The old "No bookings yet" copy told an established business
 * it had no history at all, which reads as data loss. These tests pin the
 * cutoff wording in both the header and the empty state so a copy edit can't
 * quietly bring the misleading version back.
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

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  // Keep the hand-written helpers (bookingDisplayName, missingBookingFields,
  // ...) real — they are pure functions the components under test lean on.
  ...(await importOriginal<Record<string, unknown>>()),
  useListBookings: () => query([]),
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
  window.location.hash = "";
});

describe("bookings history floor copy", () => {
  it("explains the cutoff instead of claiming there are no bookings yet", () => {
    renderPage();

    const empty = screen.getByTestId("empty-bookings");
    expect(empty).toHaveTextContent("August 1, 2026");
    expect(empty).toHaveTextContent("Jobber");
    // The old copy implied the business has never booked anyone.
    expect(empty).not.toHaveTextContent("No bookings yet");
  });

  it("says in the header where the older jobs went", () => {
    renderPage();

    const header = screen.getByText(/Quotes and approved cleans/);
    expect(header).toHaveTextContent("This list starts August 1, 2026");
    expect(header).toHaveTextContent("look up anything earlier in Jobber");
  });
});
