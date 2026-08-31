// @vitest-environment jsdom
/**
 * The click-the-booking → accept-and-assign flow.
 *
 * Pins the promises the feature makes: cards open a detail view (without
 * stealing clicks from buttons and menus inside them), pending bookings get
 * a prominent Accept button, and one confirm saves the crew FIRST and then
 * approves with scheduling — order matters, because the server reads the
 * crew from the database when it creates the Jobber visit. Also pins the
 * honesty rules: Jobber-blocked accepts say so and fall back to a local
 * confirm, and a failed schedule shows the sync error with a retry path.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";

function query(data?: unknown) {
  return { data, isLoading: false };
}
function mutation() {
  return { mutate: vi.fn(), isPending: false };
}

const approveMutate = vi.fn();
const crewMutate = vi.fn();
const crewMutateAsync = vi.fn(async () => ({}));
const createMutate = vi.fn();

function booking(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    customerName: `Customer ${id}`,
    customerPhone: "555-0100",
    customerAddress: "12 Main St",
    service: "Deep clean",
    scheduledFor: "2026-08-20T14:00:00.000Z",
    status: "pending",
    crew: [],
    quoteTotals: null,
    quoteSentTotals: null,
    jobberSynced: true,
    jobberQuoteId: "quo_1",
    ...overrides,
  };
}

const team = [
  { id: 7, name: "Zoe Cleaner", role: "cleaner", active: true, hasLogin: true },
  { id: 8, name: "Max Cleaner", role: "cleaner", active: true, hasLogin: true },
  { id: 9, name: "Dee Dispatch", role: "dispatcher", active: true },
];

let bookingsFixture: ReturnType<typeof booking>[] = [];
let companyFixture: Record<string, unknown> = {};
let userFixture: Record<string, unknown> = {};

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  // Keep the hand-written helpers (bookingDisplayName, missingBookingFields,
  // ...) real — they are pure functions the page under test leans on.
  ...(await importOriginal<Record<string, unknown>>()),
  useListBookings: () => query(bookingsFixture),
  useUpdateBooking: mutation,
  useCreateBooking: () => ({ mutate: createMutate, isPending: false }),
  useSyncBookingToJobber: mutation,
  useCreateBookingInvoice: mutation,
  useApproveBooking: () => ({ mutate: approveMutate, isPending: false }),
  useGetCompany: () => query(companyFixture),
  useGetQuotePreview: () => query(undefined),
  useSendQuote: mutation,
  useSetBookingCrew: () => ({
    mutate: crewMutate,
    mutateAsync: crewMutateAsync,
    isPending: false,
  }),
  useListTeamMembers: () => query(team),
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
    <TooltipProvider>
      <QueryClientProvider client={client}>
        <BookingsPage />
      </QueryClientProvider>
    </TooltipProvider>,
  );
}

function detailDialog() {
  return screen.getByTestId("dialog-booking-detail");
}

afterEach(() => {
  approveMutate.mockReset();
  crewMutate.mockReset();
  crewMutateAsync.mockClear();
  createMutate.mockReset();
  cleanup();
});

describe("opening the detail view", () => {
  it("shows the failed map-pin address without opening the booking", () => {
    setup({
      bookings: [
        booking(20, {
          customerAddress: "12 Mian St",
          lat: null,
          lng: null,
          geocodingFailed: true,
        }),
      ],
    });

    const warning = screen.getByTestId("warning-address-placement-booking-20");
    fireEvent.click(warning);

    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Address couldn't be placed",
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent("12 Mian St");
    expect(
      screen.queryByTestId("dialog-booking-detail"),
    ).not.toBeInTheDocument();
  });

  it("opens on a card click, showing the booking in one place", () => {
    setup({ bookings: [booking(1)] });
    fireEvent.click(screen.getByTestId("card-booking-1"));

    const dialog = detailDialog();
    expect(within(dialog).getByText("Customer 1")).toBeInTheDocument();
    expect(within(dialog).getByText("12 Main St")).toBeInTheDocument();
    expect(within(dialog).getByTestId("detail-crew")).toHaveTextContent(
      "No crew assigned",
    );
    expect(within(dialog).getByTestId("button-detail-accept")).toBeVisible();
  });

  it("leaves clicks on the card's own controls alone", () => {
    setup({ bookings: [booking(1)] });
    // The kebab trigger is a button inside the card — clicking it must not
    // also open the detail view underneath.
    const card = screen.getByTestId("card-booking-1");
    const kebab = within(card)
      .getAllByRole("button")
      .find((b) => b.getAttribute("aria-haspopup") === "menu")!;
    fireEvent.click(kebab);
    expect(screen.queryByTestId("dialog-booking-detail")).toBeNull();
  });

  it("shows a cleaner the details but none of the office actions", () => {
    setup({
      bookings: [booking(1)],
      user: { id: 2, name: "Cass", role: "cleaner" },
    });
    fireEvent.click(screen.getByTestId("card-booking-1"));

    const dialog = detailDialog();
    expect(within(dialog).getByText("Customer 1")).toBeInTheDocument();
    expect(within(dialog).queryByTestId("button-detail-accept")).toBeNull();
    expect(within(dialog).queryByTestId("button-detail-crew")).toBeNull();
    expect(within(dialog).queryByTestId("button-detail-edit")).toBeNull();
  });
});

describe("the prominent approval button", () => {
  it("appears on pending unaccepted bookings, with the card tinted", () => {
    setup({
      bookings: [
        booking(1),
        booking(2, {
          status: "confirmed",
          clientApprovedAt: "2026-08-09T10:00:00.000Z",
        }),
      ],
    });

    expect(screen.getByTestId("button-approve-1")).toBeVisible();
    expect(screen.getByTestId("card-booking-1").className).toContain(
      "border-amber-500/50",
    );
    // Already accepted — nothing to accept, no tint.
    expect(screen.queryByTestId("button-approve-2")).toBeNull();
    expect(screen.getByTestId("card-booking-2").className).not.toContain(
      "border-amber-500/50",
    );
  });

  it("is hidden from cleaners", () => {
    setup({
      bookings: [booking(1)],
      user: { id: 2, name: "Cass", role: "cleaner" },
    });
    expect(screen.queryByTestId("button-approve-1")).toBeNull();
  });
});

describe("scheduling after approval", () => {
  it("records approval from the pending detail dialog without opening scheduling", async () => {
    setup({ bookings: [booking(1)] });
    fireEvent.click(screen.getByTestId("card-booking-1"));

    const dialog = detailDialog();
    fireEvent.click(within(dialog).getByTestId("button-detail-accept"));

    expect(within(dialog).queryByTestId("button-accept-confirm")).toBeNull();
    await waitFor(() =>
      expect(approveMutate).toHaveBeenCalledWith(
        { id: 1, data: { schedule: false } },
        expect.anything(),
      ),
    );
  });

  it("saves the chosen crew first, then schedules the approved quote", async () => {
    setup({
      bookings: [
        booking(1, {
          status: "confirmed",
          clientApprovedAt: "2026-08-09T10:00:00.000Z",
        }),
      ],
    });
    fireEvent.click(screen.getByTestId("button-schedule-1"));

    const dialog = detailDialog();
    fireEvent.click(within(dialog).getByText("Zoe Cleaner"));
    const confirm = within(dialog).getByTestId("button-accept-confirm");
    expect(confirm).toHaveTextContent("Schedule & assign crew");
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(approveMutate).toHaveBeenCalledWith(
        { id: 1, data: { schedule: true } },
        expect.anything(),
      ),
    );
    expect(crewMutateAsync).toHaveBeenCalledWith({
      id: 1,
      data: { teamMemberIds: [7] },
    });
    // Crew must land before the approve call reads it to pick Jobber
    // assignees.
    expect(crewMutateAsync.mock.invocationCallOrder[0]).toBeLessThan(
      approveMutate.mock.invocationCallOrder[0],
    );
    // Dispatchers don't clean, so the picker never offered one.
    expect(within(dialog).queryByText("Dee Dispatch")).toBeNull();
  });

  it("skips the crew write when the crew didn't change", async () => {
    setup({
      bookings: [
        booking(1, {
          status: "confirmed",
          clientApprovedAt: "2026-08-09T10:00:00.000Z",
          crew: [{ id: 7, name: "Zoe Cleaner", role: "cleaner", color: null }],
        }),
      ],
    });
    fireEvent.click(screen.getByTestId("button-schedule-1"));
    fireEvent.click(
      within(detailDialog()).getByTestId("button-accept-confirm"),
    );

    await waitFor(() => expect(approveMutate).toHaveBeenCalled());
    expect(crewMutateAsync).not.toHaveBeenCalled();
  });

  it("records approval locally even when there is no Jobber quote", async () => {
    setup({ bookings: [booking(1, { jobberQuoteId: null })] });
    expect(screen.queryByTestId("button-schedule-1")).toBeNull();
    fireEvent.click(screen.getByTestId("button-approve-1"));

    await waitFor(() =>
      expect(approveMutate).toHaveBeenCalledWith(
        { id: 1, data: { schedule: false } },
        expect.anything(),
      ),
    );
  });
});

describe("already-accepted bookings", () => {
  it("offers reassignment and the existing actions instead of Accept", () => {
    setup({
      bookings: [
        booking(1, {
          status: "confirmed",
          clientApprovedAt: "2026-08-09T10:00:00.000Z",
          jobberCreatedJobId: "job_1",
          jobberJobWebUri: "https://jobber/job_1",
          jobberClientId: "cli_1",
          crew: [{ id: 7, name: "Zoe Cleaner", role: "cleaner", color: null }],
        }),
      ],
    });
    fireEvent.click(screen.getByTestId("button-queue-scheduled"));
    fireEvent.click(screen.getByTestId("card-booking-1"));

    const dialog = detailDialog();
    expect(within(dialog).queryByTestId("button-detail-accept")).toBeNull();
    // Already on the calendar — no schedule button either.
    expect(within(dialog).queryByTestId("button-detail-schedule")).toBeNull();
    expect(within(dialog).getByTestId("button-detail-crew")).toHaveTextContent(
      "Change crew",
    );
    expect(within(dialog).getByTestId("button-detail-edit")).toBeVisible();
    expect(within(dialog).getByTestId("button-detail-invoice")).toBeVisible();
    expect(
      within(dialog).getByTestId("link-detail-jobber-job"),
    ).toHaveAttribute("href", "https://jobber/job_1");
  });

  it("saves a crew reassignment from the detail view", async () => {
    setup({
      bookings: [
        booking(1, {
          status: "confirmed",
          clientApprovedAt: "2026-08-09T10:00:00.000Z",
          jobberCreatedJobId: "job_1",
        }),
      ],
    });
    fireEvent.click(screen.getByTestId("button-queue-scheduled"));
    fireEvent.click(screen.getByTestId("card-booking-1"));

    const dialog = detailDialog();
    fireEvent.click(within(dialog).getByTestId("button-detail-crew"));
    fireEvent.click(within(dialog).getByText("Max Cleaner"));
    fireEvent.click(within(dialog).getByTestId("button-crew-save"));

    expect(crewMutate).toHaveBeenCalledWith(
      { id: 1, data: { teamMemberIds: [8] } },
      expect.anything(),
    );
  });
});

describe("failure honesty", () => {
  it("shows the sync error and a retry path when Jobber refused the schedule", async () => {
    setup({
      bookings: [
        booking(1, {
          status: "confirmed",
          clientApprovedAt: "2026-08-09T10:00:00.000Z",
          jobberCreatedJobId: null,
          jobberSyncError: "Jobber said no",
          jobberSyncErrorAt: "2026-08-13T10:00:00.000Z",
        }),
      ],
    });
    fireEvent.click(screen.getByTestId("card-booking-1"));

    const dialog = detailDialog();
    expect(within(dialog).getByTestId("detail-sync-error")).toHaveTextContent(
      "Jobber said no",
    );
    const retry = within(dialog).getByTestId("button-detail-schedule");
    expect(retry).toHaveTextContent("Retry scheduling in Jobber");
    fireEvent.click(retry);
    fireEvent.click(within(dialog).getByTestId("button-accept-confirm"));

    // Approve is idempotent server-side: the retry re-runs only the
    // scheduling half.
    await waitFor(() =>
      expect(approveMutate).toHaveBeenCalledWith(
        { id: 1, data: { schedule: true } },
        expect.anything(),
      ),
    );
  });
});

describe("optional booking fields on this page", () => {
  it("shows a nameless booking's phone number in the detail view, never a blank heading", () => {
    setup({
      bookings: [
        booking(1, { customerName: "", customerPhone: "780-555-0100" }),
      ],
    });
    fireEvent.click(screen.getByTestId("card-booking-1"));

    const dialog = detailDialog();
    // The heading and the sr-only description both fall back to the phone.
    expect(within(dialog).getAllByText("780-555-0100").length).toBeGreaterThan(
      0,
    );
  });

  it("labels a booking with no name and no phone 'No name'", () => {
    setup({
      bookings: [booking(1, { customerName: "", customerPhone: "" })],
    });
    fireEvent.click(screen.getByTestId("card-booking-1"));
    expect(
      within(detailDialog()).getAllByText("No name").length,
    ).toBeGreaterThan(0);
  });

  it("holds an add-dialog save until a field the owner toggled required is filled", async () => {
    setup({
      bookings: [],
      company: { bookingRequiredFields: ["email"] },
    });
    fireEvent.click(screen.getByText("Add booking"));

    // Email is required, so its label carries the asterisk instead of
    // "(optional)" — and saving without it goes nowhere.
    const emailBox = screen.getByLabelText(/Email/);
    fireEvent.click(screen.getByRole("button", { name: "Add booking" }));
    expect(createMutate).not.toHaveBeenCalled();

    fireEvent.change(emailBox, { target: { value: "jay@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add booking" }));
    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    expect(createMutate.mock.calls[0][0].data.customerEmail).toBe(
      "jay@example.com",
    );
  });
});
