// @vitest-environment jsdom
/**
 * The separate approval and scheduling actions on the Bookings page.
 *
 * "Confirmed" now means one thing — the client said yes — so this pins the
 * things a future edit could quietly undo: that approval is prominent and
 * local-only, that scheduling appears only after approval and is greyed out *with the reason*
 * when there is no Jobber quote or Jobber needs reconnecting, that the badge
 * and the approval pill say who confirmed it, and that a scheduled booking
 * links to its Jobber job.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function query(data?: unknown) {
  return { data, isLoading: false };
}
function mutation() {
  return { mutate: vi.fn(), isPending: false };
}

const approveMutate = vi.fn();

function booking(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    customerName: `Customer ${id}`,
    customerPhone: "555-0100",
    customerAddress: "12 Main St",
    service: "Deep clean",
    scheduledFor: "2026-08-10T14:00:00.000Z",
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
  useApproveBooking: () => ({ mutate: approveMutate, isPending: false }),
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
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BookingsPage />
    </QueryClientProvider>,
  );
}

/**
 * Open the row's ⋯ menu, which is where both actions live. Opened from the
 * keyboard because the mouse path needs PointerEvent, which jsdom hasn't got.
 */
function openMenu() {
  const trigger = screen
    .getAllByRole("button")
    .find((b) => b.getAttribute("aria-haspopup") === "menu")!;
  fireEvent.keyDown(trigger, { key: "Enter" });
}

afterEach(() => {
  approveMutate.mockReset();
  cleanup();
});

describe("approving from the Bookings list", () => {
  it("offers a prominent action and records the plain approval", () => {
    setup({ bookings: [booking(1)] });

    fireEvent.click(screen.getByTestId("button-approve-1"));
    expect(approveMutate).toHaveBeenCalledWith(
      { id: 1, data: { schedule: false } },
      expect.anything(),
    );
  });

  it("schedules into Jobber only after approval", () => {
    setup({
      bookings: [
        booking(1, {
          status: "confirmed",
          clientApprovedAt: "2026-08-09T10:00:00.000Z",
        }),
      ],
    });
    openMenu();

    fireEvent.click(screen.getByTestId("menu-approve-schedule-1"));
    expect(approveMutate).toHaveBeenCalledWith(
      { id: 1, data: { schedule: true } },
      expect.anything(),
    );
  });

  it("greys scheduling out with the reason when there is no Jobber quote", () => {
    setup({
      bookings: [
        booking(1, {
          status: "confirmed",
          clientApprovedAt: "2026-08-09T10:00:00.000Z",
          jobberQuoteId: null,
        }),
      ],
    });
    openMenu();

    const item = screen.getByTestId("menu-approve-schedule-1");
    expect(item).toHaveTextContent("no Jobber quote yet");
    fireEvent.click(item);
    expect(approveMutate).not.toHaveBeenCalled();
  });

  it("greys scheduling out when Jobber needs reconnecting", () => {
    setup({
      bookings: [
        booking(1, {
          status: "confirmed",
          clientApprovedAt: "2026-08-09T10:00:00.000Z",
        }),
      ],
      company: { jobberNeedsReauth: true },
    });
    openMenu();

    expect(screen.getByTestId("menu-approve-schedule-1")).toHaveTextContent(
      "reconnect Jobber first",
    );
  });

  it("drops the Approve action once the client has approved, keeping the schedule one", () => {
    setup({
      bookings: [
        booking(1, {
          status: "confirmed",
          clientApprovedAt: "2026-08-09T10:00:00.000Z",
          clientApprovedBy: "Pat Owner",
        }),
      ],
    });
    openMenu();

    expect(screen.queryByTestId("menu-approve-1")).toBeNull();
    expect(screen.getByTestId("menu-approve-schedule-1")).toBeInTheDocument();
  });

  it("keeps a Jobber-observed approval labelled as Jobber and makes scheduling available", () => {
    setup({
      bookings: [
        booking(1, {
          status: "pending",
          clientApprovedAt: null,
          clientApprovedBy: null,
          quoteApprovedAt: null,
          jobberQuoteStatus: "APPROVED",
        }),
      ],
    });

    expect(screen.queryByTestId("button-approve-1")).toBeNull();
    expect(screen.getByTestId("button-schedule-1")).toBeInTheDocument();
    expect(screen.getByTestId("badge-approved-jobber-1")).toHaveTextContent(
      "Approved in Jobber",
    );
    expect(screen.queryByText(/recorded by/i)).toBeNull();
  });

  it("says the client confirmed it, and who recorded that", () => {
    setup({
      bookings: [
        booking(1, {
          status: "confirmed",
          clientApprovedAt: "2026-08-09T10:00:00.000Z",
          clientApprovedBy: "Pat Owner",
        }),
      ],
    });

    expect(screen.getByText("Client confirmed")).toBeInTheDocument();
    expect(screen.getByTestId("badge-approved-1")).toHaveTextContent(
      "recorded by Pat Owner",
    );
  });

  it("links the scheduled job in Jobber alongside the request and quote", () => {
    setup({
      bookings: [
        booking(1, {
          status: "confirmed",
          clientApprovedAt: "2026-08-09T10:00:00.000Z",
          jobberCreatedJobId: "job_1",
          jobberJobWebUri: "https://jobber/job_1",
        }),
      ],
    });
    fireEvent.click(screen.getByTestId("button-queue-scheduled"));

    expect(screen.getByTestId("link-jobber-job-1")).toHaveAttribute(
      "href",
      "https://jobber/job_1",
    );
    // Already scheduled — offering to schedule it again would be a lie.
    openMenu();
    expect(screen.queryByTestId("menu-approve-schedule-1")).toBeNull();
  });

  it("shows neither action to a cleaner", () => {
    setup({
      bookings: [booking(1)],
      user: { id: 2, name: "Cass", role: "cleaner" },
    });
    openMenu();

    expect(screen.queryByTestId("menu-approve-1")).toBeNull();
    expect(screen.queryByTestId("menu-approve-schedule-1")).toBeNull();
  });
});
