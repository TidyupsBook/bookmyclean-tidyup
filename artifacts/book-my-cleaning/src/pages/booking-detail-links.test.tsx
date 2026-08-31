// @vitest-environment jsdom
/**
 * The schedule and map booking detail surfaces both deep-link into the
 * Bookings page. That page finds and highlights a card only for the exact
 * format /bookings#booking-<id> (pinned by bookings.hash-highlight.test.tsx),
 * so if either surface drifts to another hash the link silently does nothing.
 * These tests pin both emitters to the same working format.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

function query(data?: unknown) {
  return { data, isLoading: false };
}
function mutation() {
  return { mutate: vi.fn(), isPending: false };
}

const BOOKING = {
  id: 42,
  customerName: "Ann Alpha",
  customerPhone: "555-0100",
  customerEmail: null,
  customerAddress: "12 Main St",
  service: "Deep clean",
  scheduledFor: "2026-08-10T14:00:00.000Z",
  status: "confirmed",
  crew: [],
  quotedAmount: null,
  durationMinutes: 120,
  bedrooms: null,
  bathrooms: null,
  frequency: null,
  extras: [],
  internalNotes: null,
};

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  // Keep the hand-written helpers (bookingDisplayName, missingBookingFields,
  // ...) real — they are pure functions the components under test lean on.
  ...(await importOriginal<Record<string, unknown>>()),
  useGetBooking: () => query(BOOKING),
  useGetCompany: () =>
    query({ id: 1, name: "Sparkle Co", timezone: "America/Toronto" }),
  useGetCurrentUser: () => query({ id: 1, name: "Pat", role: "owner" }),
  useUpdateBooking: mutation,
  useApproveBooking: mutation,
  getGetBookingQueryKey: (id: number) => ["/api/bookings", id],
  getListBookingsQueryKey: () => ["/api/bookings"],
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BookingDetailPanel } from "@/components/BookingDetailPanel";
import { editInBookingsHtml } from "@/lib/mapMarkerDom";

afterEach(cleanup);

describe("schedule booking detail panel", () => {
  it("links 'Open in Bookings' to /bookings#booking-<id> for the selected job", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, enabled: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <BookingDetailPanel bookingId={42} onClose={() => {}} />
      </QueryClientProvider>,
    );

    const link = screen.getByTestId("link-open-in-bookings");
    expect(link).toHaveAttribute("href", "/bookings#booking-42");
  });
});

describe("map booking info window", () => {
  it("links 'Edit in Bookings' to /bookings#booking-<id> for the selected job", () => {
    const html = editInBookingsHtml(42);
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    const anchor = wrap.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute("href")).toBe("/bookings#booking-42");
    expect(anchor!.textContent).toContain("Edit in Bookings");
  });
});
