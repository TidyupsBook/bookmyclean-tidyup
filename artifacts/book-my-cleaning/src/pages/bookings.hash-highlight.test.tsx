// @vitest-environment jsdom
/**
 * Landing on /bookings#booking-<id> (dashboard activity feed, schedule/map
 * detail panels) must scroll the matching card into view and flash it with
 * the highlight ring. These tests pin the hash handler so a refactor can't
 * silently stop the deep link from finding or highlighting the card.
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

function booking(
  id: number,
  customerName: string,
  extra: Record<string, unknown> = {},
) {
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
    ...extra,
  };
}

let bookingsCache: ReturnType<typeof booking>[] | null = null;
function bookingsFixture() {
  // Stable identity across renders, like react-query's cached data — the
  // page's hash effect keys off the array reference.
  bookingsCache ??= [
    booking(1, "Ann Alpha"),
    booking(2, "Bo Bravo"),
    booking(3, "Cy Charlie"),
  ];
  return bookingsCache;
}

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  // Keep the hand-written helpers (bookingDisplayName, missingBookingFields,
  // ...) real — they are pure functions the components under test lean on.
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

// jsdom has no layout engine; capture calls instead.
const scrollSpy = vi.fn();
window.HTMLElement.prototype.scrollIntoView = scrollSpy;

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
  scrollSpy.mockClear();
  window.location.hash = "";
  bookingsCache = null;
});

const RING = "ring-2";

describe("bookings hash deep link", () => {
  it("scrolls to and highlights the card matching #booking-<id>", () => {
    window.location.hash = "#booking-2";
    renderPage();

    const target = document.getElementById("booking-2");
    expect(target).not.toBeNull();
    expect(target!).toHaveTextContent("Bo Bravo");
    expect(target!.className).toContain(RING);

    // scrollIntoView was invoked on the matching card, and only that one.
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy.mock.instances[0]).toBe(target);

    // The other cards stay unhighlighted.
    expect(document.getElementById("booking-1")!.className).not.toContain(RING);
    expect(document.getElementById("booking-3")!.className).not.toContain(RING);
  });

  it("does nothing without a booking hash", () => {
    renderPage();
    expect(scrollSpy).not.toHaveBeenCalled();
    expect(document.getElementById("booking-1")!.className).not.toContain(RING);
    expect(document.getElementById("booking-2")!.className).not.toContain(RING);
  });

  it("reveals a scheduled appointment opened from the calendar", () => {
    bookingsCache = [
      booking(1, "Ann Alpha", {
        status: "confirmed",
        jobberCreatedJobId: "job_1",
      }),
    ];
    window.location.hash = "#booking-1";
    renderPage();
    expect(document.getElementById("booking-1")).not.toBeNull();
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  it("expands a recurring series when a calendar link targets a later visit", () => {
    bookingsCache = [
      booking(1, "Ann Alpha", {
        status: "confirmed",
        service: "Recurring clean",
        scheduledFor: "2026-09-01T14:00:00.000Z",
      }),
      booking(2, "Ann Alpha", {
        status: "confirmed",
        service: "Recurring clean",
        scheduledFor: "2026-09-08T14:00:00.000Z",
      }),
    ];
    window.location.hash = "#booking-2";
    renderPage();

    expect(document.getElementById("booking-1")).not.toBeNull();
    expect(document.getElementById("booking-2")).not.toBeNull();
    expect(document.getElementById("booking-2")!.className).toContain(RING);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  it("points at Jobber when the hash targets a job below the history floor", () => {
    // The list starts August 1, 2026, so a link to an older job finds no card.
    // Saying nothing looks broken; say where the job actually lives.
    window.location.hash = "#booking-999";
    renderPage();
    expect(scrollSpy).not.toHaveBeenCalled();
    const notice = screen.getByTestId("pre-cutoff-notice");
    expect(notice).toHaveTextContent("August 1, 2026");
    expect(notice).toHaveTextContent("Jobber");
  });
});
