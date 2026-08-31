// @vitest-environment jsdom
/**
 * "Create quote" from a lead card: the same booking form, rearranged around
 * the price, ending in the text-a-quote step.
 *
 * What's pinned here is the shape of that trip: &intent=quote puts the
 * calculator column first and renames the page and the save button; saving
 * still creates the booking with the lead riding along and still converts
 * the lead one-shot (a lost race included); and the exit is
 * /bookings?quote=<id> — the Text-a-quote dialog — never the bare bookings
 * list the dispatcher would have to hunt through.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

function query(data?: unknown) {
  return { data, isLoading: false };
}
function mutation() {
  return { mutate: vi.fn(), isPending: false };
}

let userFixture: Record<string, unknown> = { canTakeLiveCalls: false };
let companyFixture: Record<string, unknown> = { timezone: "America/Edmonton" };

/** The lead the card was clicked on — prefills the form. */
const leadFixture = {
  id: 7,
  name: "Lena Quoted",
  firstName: "Lena",
  lastName: "Quoted",
  phoneDisplay: "780-555-0110",
  phoneE164: "+17805550110",
  email: null,
  streetAddress: "12 Maple Crescent",
  city: "Edmonton",
  province: "AB",
  postCode: "T5J 0N3",
  service: null,
  bedrooms: null,
  bathrooms: null,
  platform: null,
  campaignName: null,
  dateOfServiceRequested: null,
  status: "new",
  source: "jobber",
};

const createBookingMutate = vi.hoisted(() => vi.fn());
const convertLeadMutate = vi.hoisted(() => vi.fn());
const navigateSpy = vi.hoisted(() => vi.fn());
let searchFixture = "leadId=7&intent=quote";

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  // Keep the hand-written helpers real — they are pure functions the page
  // leans on (bookingDisplayName, missingBookingFields, ...).
  ...(await importOriginal<Record<string, unknown>>()),
  useGetCompany: () => query(companyFixture),
  useGetCurrentUser: () => query(userFixture),
  useGetMapConfig: () => query({ configured: true, apiKey: "test-key" }),
  useListCalls: () => query([]),
  useListServices: () => query([{ name: "Deep clean" }]),
  useListTeamMembers: () => query([]),
  useCreateBooking: () => ({ mutate: createBookingMutate, isPending: false }),
  useGetLead: () => query(leadFixture),
  useGetBooking: () => query(undefined),
  useConvertLead: () => ({ mutate: convertLeadMutate, isPending: false }),
  getBooking: vi.fn(),
  getCallBookingDraft: vi.fn(),
  getListCallsQueryKey: () => ["/api/calls"],
  draftBookingFromText: vi.fn(),
  useListBookingsInRange: () => query({ bookings: [] }),
  getListBookingsInRangeQueryKey: () => ["/api/bookings/range"],
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: () => ({ data: undefined }),
    useMutation: (opts: {
      mutationFn: (arg: unknown) => Promise<unknown>;
      onSuccess?: (result: unknown) => void;
      onError?: (err: unknown) => void;
    }) => ({
      mutate: (arg: unknown) => {
        opts.mutationFn(arg).then(
          (result) => opts.onSuccess?.(result),
          (err) => opts.onError?.(err),
        );
      },
      isPending: false,
    }),
  };
});

vi.mock("wouter", () => ({
  useLocation: () => ["/bookings/new", navigateSpy],
  useSearch: () => searchFixture,
}));

vi.mock("@/components/layout/AppLayout", () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/components/QuoteCalculator", () => ({
  QuoteCalculator: (props: { saveQuoteHint?: string }) => (
    <div data-testid="quote-calculator">{props.saveQuoteHint ?? ""}</div>
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
vi.mock("@/components/BookingAddressMap", () => ({
  BookingAddressMap: () => <div data-testid="address-map" />,
}));
vi.mock("@/components/AddressAutocomplete", () => ({
  AddressAutocomplete: (props: {
    id?: string;
    value: string;
    onChange: (v: string) => void;
  }) => (
    <input
      id={props.id}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    />
  ),
}));
const toastSpy = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));
vi.mock("@/components/CaptureControls", () => ({
  CaptureStatusLine: () => null,
  CaptureControls: () => null,
}));
vi.mock("@/lib/desktopNotify", () => ({
  askToNotify: async () => "granted",
  notifyPermission: () => "granted",
}));
vi.mock("@/lib/callCapture", () => ({
  useCallCapture: () => null,
  declineMessage: () => "",
}));

import { NewBookingPage } from "./new-booking";

afterEach(() => {
  cleanup();
  userFixture = { canTakeLiveCalls: false };
  companyFixture = { timezone: "America/Edmonton" };
  searchFixture = "leadId=7&intent=quote";
  createBookingMutate.mockReset();
  convertLeadMutate.mockReset();
  navigateSpy.mockReset();
  toastSpy.mockReset();
});

/** A save that succeeds, handing back the new booking. */
function saveSucceedsWith(bookingId: number) {
  createBookingMutate.mockImplementation(
    (
      _vars: unknown,
      opts: { onSuccess: (b: { id: number; customerName: string }) => void },
    ) => opts.onSuccess({ id: bookingId, customerName: "Lena Quoted" }),
  );
}

describe("the quote-mode form", () => {
  it("arrives arranged around the price", () => {
    render(<NewBookingPage />);

    expect(screen.getByText("New Quote")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Save & text the quote/ }),
    ).toBeInTheDocument();
    // The calculator column leads; the frequency/notes column follows it.
    const calcColumn = screen.getByTestId("quote-calculator").parentElement!;
    expect(calcColumn.className).toContain("order-1");
    // And the calculator's own Save explains where the trip goes next.
    expect(screen.getByTestId("quote-calculator")).toHaveTextContent(
      "straight to texting the quote",
    );
  });

  it("keeps the ordinary layout without the quote intent", () => {
    searchFixture = "leadId=7";
    render(<NewBookingPage />);

    expect(screen.getByText("New Booking")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Save booking/ }),
    ).toBeInTheDocument();
    const calcColumn = screen.getByTestId("quote-calculator").parentElement!;
    expect(calcColumn.className).not.toContain("order-1");
  });

  it("saves with the lead riding along, converts it, and lands in the text-a-quote step", () => {
    saveSucceedsWith(99);
    convertLeadMutate.mockImplementation(
      (_vars: unknown, opts: { onSuccess: () => void }) => opts.onSuccess(),
    );
    render(<NewBookingPage />);

    fireEvent.click(screen.getByTestId("button-save-booking"));

    // The booking carries the lead id so the server stamps the lead's
    // Jobber client/request onto it at creation — the quote push reuses
    // those instead of minting duplicates.
    const sent = createBookingMutate.mock.calls[0]![0] as {
      data: { leadId: number | null; customerName?: string };
    };
    expect(sent.data.leadId).toBe(7);
    // The same one-shot convert as the booking path.
    expect(convertLeadMutate).toHaveBeenCalledTimes(1);
    expect(convertLeadMutate.mock.calls[0]![0]).toEqual({
      id: 7,
      data: { bookingId: 99 },
    });
    // And the exit is the Text-a-quote dialog, not the bare list.
    expect(navigateSpy).toHaveBeenCalledWith("/bookings?quote=99");
  });

  it("a lost convert race still goes on to the text-a-quote step", () => {
    saveSucceedsWith(99);
    convertLeadMutate.mockImplementation(
      (_vars: unknown, opts: { onError: (err: unknown) => void }) =>
        opts.onError({ status: 409 }),
    );
    render(<NewBookingPage />);

    fireEvent.click(screen.getByTestId("button-save-booking"));

    // 409 is terminal — someone else converted first — so the quote trip
    // continues rather than stranding the dispatcher on the form.
    expect(navigateSpy).toHaveBeenCalledWith("/bookings?quote=99");
  });

  it("an ordinary save from a lead still exits to the bookings list", () => {
    searchFixture = "leadId=7";
    saveSucceedsWith(42);
    convertLeadMutate.mockImplementation(
      (_vars: unknown, opts: { onSuccess: () => void }) => opts.onSuccess(),
    );
    render(<NewBookingPage />);

    fireEvent.click(screen.getByTestId("button-save-booking"));
    expect(navigateSpy).toHaveBeenCalledWith("/bookings");
  });
});
