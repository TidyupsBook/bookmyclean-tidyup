// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const hooks = vi.hoisted(() => ({
  syncMutate: vi.fn(),
}));

function mutation(overrides: Record<string, unknown> = {}) {
  return {
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    reset: vi.fn(),
    ...overrides,
  };
}

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useListTeamMembers: () => ({ data: [] }),
  useSetBookingCrew: () => mutation(),
  useApproveBooking: () => mutation(),
  useSyncBookingToJobber: () =>
    mutation({
      mutate: hooks.syncMutate,
    }),
  getListBookingsQueryKey: () => ["/api/bookings"],
}));

vi.mock("@/components/PhoneActions", () => ({
  PhoneActions: () => null,
}));

vi.mock("@/components/CustomerTagControls", () => ({
  CustomerTagPicker: () => null,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { BookingDetailDialog } from "./BookingDetailDialog";

const baseBooking = {
  id: 71,
  customerName: "Dana",
  customerPhone: "555-0100",
  customerAddress: "12 Main St",
  service: "Deep clean",
  scheduledFor: "2026-08-10T14:00:00.000Z",
  status: "confirmed",
  quoteTotals: null,
  quoteSentTotals: null,
  jobberSynced: false,
  jobberSyncError: "Jobber is unavailable",
  jobberSyncErrorAt: "2026-08-10T12:00:00.000Z",
  crew: [],
};

function renderDialog(
  booking: Record<string, unknown>,
  { jobberNeedsReauth = false } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BookingDetailDialog
        booking={booking as any}
        mode="detail"
        onClose={() => {}}
        canDispatch
        timeZone="America/Toronto"
        jobberConnected
        jobberNeedsReauth={jobberNeedsReauth}
        onEdit={() => {}}
        onQuote={() => {}}
        onCreateInvoice={() => {}}
        invoicePending={false}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("booking detail Jobber retry handoff", () => {
  it("shows the next automatic retry and remaining budget", () => {
    renderDialog({
      ...baseBooking,
      jobberAutomaticRetryStatus: "pending",
      jobberAutomaticRetriesRemaining: 3,
      jobberNextRetryAt: "2099-08-10T12:04:00.000Z",
    });

    const status = screen.getByTestId("detail-jobber-retry-status");
    expect(status).toHaveTextContent("Automatic retry pending");
    expect(status).toHaveTextContent("3 automatic retries remaining");
    expect(status).toHaveTextContent("Next automatic retry");
  });

  it("keeps manual Sync to Jobber available after retries are exhausted", () => {
    renderDialog(
      {
        ...baseBooking,
        jobberAutomaticRetryStatus: "exhausted",
        jobberAutomaticRetriesRemaining: 0,
        jobberNextRetryAt: null,
        jobberRetryUsesBookingConnection: true,
      },
      { jobberNeedsReauth: true },
    );

    expect(screen.getByTestId("detail-jobber-retry-status")).toHaveTextContent(
      "Automatic retries exhausted",
    );
    const button = screen.getByTestId("button-detail-sync-jobber");
    expect(button).toHaveTextContent("Sync to Jobber");

    fireEvent.click(button);
    expect(hooks.syncMutate).toHaveBeenCalledWith(
      { id: 71 },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it("does not offer Sync for a primary booking until Jobber is reconnected", () => {
    renderDialog(
      {
        ...baseBooking,
        jobberAutomaticRetryStatus: "exhausted",
        jobberAutomaticRetriesRemaining: 0,
        jobberNextRetryAt: null,
        jobberRetryUsesBookingConnection: false,
      },
      { jobberNeedsReauth: true },
    );

    expect(screen.queryByTestId("button-detail-sync-jobber")).toBeNull();
  });

  it("does not offer the generic sync action for manual-only failures", () => {
    renderDialog({
      ...baseBooking,
      jobberAutomaticRetryStatus: "manual",
      jobberAutomaticRetriesRemaining: null,
      jobberNextRetryAt: null,
    });

    expect(screen.getByTestId("detail-jobber-retry-status")).toHaveTextContent(
      "Automatic retries stopped",
    );
    expect(screen.queryByTestId("button-detail-sync-jobber")).toBeNull();
  });
});
