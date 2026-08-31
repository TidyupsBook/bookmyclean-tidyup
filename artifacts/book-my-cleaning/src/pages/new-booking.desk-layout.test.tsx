// @vitest-environment jsdom
/**
 * The shape of the booking desk, which is the whole feature.
 *
 * A dispatcher takes a booking with a customer talking in their ear. What they
 * need on the first screen is the transcript, the boxes it is filling in, and
 * the address on a map — anything below the fold may as well not be filling
 * itself in, because nobody scrolls while someone is reciting a postal code.
 *
 * So these tests pin the arrangement itself: the customer's boxes live *inside*
 * the live call panel, the map is fed the address as it is typed, and the
 * dispatcher with no live-call entitlement still gets the same boxes. They also
 * pin the deliberately short save rule — a name and a time — because the
 * previous rule (a phone number and a service too) is exactly what sent
 * half-finished bookings onto sticky notes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

function query(data?: unknown) {
  return { data, isLoading: false };
}
function mutation() {
  return { mutate: vi.fn(), isPending: false };
}

let userFixture: Record<string, unknown> = { canTakeLiveCalls: true };
// By default this company requires nothing — the owner's toggles in
// Settings → Booking form are what make a field required again.
let companyFixture: Record<string, unknown> = { timezone: "America/Edmonton" };

/** Stable across renders so the save tests can read what was sent. */
const createBookingMutate = vi.hoisted(() => vi.fn());

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  // Keep the hand-written helpers (bookingDisplayName, missingBookingFields,
  // ...) real — they are pure functions the components under test lean on.
  ...(await importOriginal<Record<string, unknown>>()),
  useGetCompany: () => query(companyFixture),
  useGetCurrentUser: () => query(userFixture),
  useGetMapConfig: () => query({ configured: true, apiKey: "test-key" }),
  useListCalls: () => query([]),
  useListServices: () => query([{ name: "Deep clean" }]),
  useListTeamMembers: () => query([]),
  useCreateBooking: () => ({ mutate: createBookingMutate, isPending: false }),
  // The desk can be opened from a lead; these tests never are, so the
  // prefill query stays empty and the conversion is never fired.
  useGetLead: () => query(undefined),
  // Same for the map's "book them here" links: no ?rebookId in these tests,
  // so the copy-the-client query stays empty.
  useGetBooking: () => query(undefined),
  useConvertLead: mutation,
  getBooking: vi.fn(),
  getCallBookingDraft: vi.fn(),
  getListCallsQueryKey: () => ["/api/calls"],
  draftBookingFromText: vi.fn(),
  // The month glance beside the map reads the whole visible grid.
  useListBookingsInRange: () => query({ bookings: monthBookings }),
  getListBookingsInRangeQueryKey: () => ["/api/bookings/range"],
}));

/** What the month box is told is already on the calendar. */
let monthBookings: Array<{
  bookingId: number;
  customerName: string;
  scheduledFor: string;
}> = [];

// A real-enough useMutation: it runs the mutationFn and delivers onSuccess /
// onError, because the stale-scan tests below are about *when* the answer
// lands relative to a Clear press — a mutate that does nothing can't test
// that.
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
  useLocation: () => ["/bookings/new", vi.fn()],
  useSearch: () => "",
}));

vi.mock("@/components/layout/AppLayout", () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/components/QuoteCalculator", () => ({
  QuoteCalculator: () => <div data-testid="quote-calculator" />,
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
// The real map talks to Google; what matters here is what it is handed.
vi.mock("@/components/BookingAddressMap", () => ({
  BookingAddressMap: (props: { street: string; city: string }) => (
    <div data-testid="address-map">{`${props.street}|${props.city}`}</div>
  ),
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

const clearWords = vi.fn();
/** A microphone session that is running with words already in it. */
let captureFixture: Record<string, unknown> | null = null;

vi.mock("@/lib/callCapture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/callCapture")>()),
  useCallCapture: () => captureFixture,
  declineMessage: () => "",
}));
vi.mock("@/components/CaptureControls", () => ({
  CaptureStatusLine: () => <div data-testid="capture-status" />,
  CaptureControls: () => <div data-testid="capture-controls" />,
}));
vi.mock("@/lib/desktopNotify", () => ({
  askToNotify: async () => "granted",
  notifyPermission: () => "granted",
}));

import { NewBookingPage } from "./new-booking";
import { draftBookingFromText } from "@workspace/api-client-react";
import { formatDateWords, resolveTypedDate } from "@/lib/time";

const draftFromText = vi.mocked(draftBookingFromText);

afterEach(() => {
  cleanup();
  userFixture = { canTakeLiveCalls: true };
  companyFixture = { timezone: "America/Edmonton" };
  captureFixture = null;
  monthBookings = [];
  clearWords.mockClear();
  toastSpy.mockClear();
  draftFromText.mockReset();
  createBookingMutate.mockReset();
});

function listeningCapture(text: string) {
  return {
    transcript: {
      supported: true,
      status: "listening",
      listening: true,
      starting: false,
      paused: false,
      reconnecting: false,
      active: true,
      text,
      interim: "",
      error: null,
      stopReason: null,
      failed: false,
      quiet: false,
      elapsedMs: 1000,
      start: vi.fn(),
      stop: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      restart: vi.fn(),
      clear: clearWords,
    },
    autoListen: true,
    setAutoListen: vi.fn(),
    soundOn: true,
    setSoundOn: vi.fn(),
    capturingCallId: null,
    callLooksOver: false,
    noteCallOver: vi.fn(),
    needsPermission: false,
    declined: null,
    noteDecline: vi.fn(),
    clearDecline: vi.fn(),
    startForCall: vi.fn(),
    startManually: vi.fn(),
    endCapture: vi.fn(),
    pauseCapture: vi.fn(),
    resumeCapture: vi.fn(),
    restartCapture: vi.fn(),
  };
}

describe("the booking desk layout", () => {
  it("keeps the customer's boxes inside the live call panel", () => {
    render(<NewBookingPage />);
    const panel = screen.getByText("Live call").closest("section");
    expect(panel).not.toBeNull();
    // The boxes the call fills in have to be in the same panel as the
    // transcript — not in a section further down the page.
    expect(within(panel!).getByLabelText("First name")).toBeInTheDocument();
    expect(within(panel!).getByLabelText("Phone number")).toBeInTheDocument();
    expect(within(panel!).getByLabelText("Street address")).toBeInTheDocument();
  });

  it("gives a dispatcher without live calls the same boxes", () => {
    userFixture = { canTakeLiveCalls: false };
    render(<NewBookingPage />);
    expect(screen.queryByText("Live call")).not.toBeInTheDocument();
    expect(screen.getByLabelText("First name")).toBeInTheDocument();
    expect(screen.getByLabelText("Street address")).toBeInTheDocument();
  });

  it("feeds the map the address as it is typed", () => {
    render(<NewBookingPage />);
    fireEvent.change(screen.getByLabelText("Street address"), {
      target: { value: "5810 Mullen Place" },
    });
    fireEvent.change(screen.getByLabelText("City"), {
      target: { value: "Edmonton" },
    });
    expect(screen.getByTestId("address-map")).toHaveTextContent(
      "5810 Mullen Place|Edmonton",
    );
  });

  it("saves the optional unit line entered on a new booking", () => {
    render(<NewBookingPage />);
    fireEvent.change(screen.getByLabelText("First name"), {
      target: { value: "Jay" },
    });
    fireEvent.change(screen.getByLabelText(/Unit \/ suite \/ apartment/), {
      target: { value: "Unit 204" },
    });

    fireEvent.click(screen.getByTestId("button-save-booking"));

    const sent = createBookingMutate.mock.calls[0]![0] as {
      data: { addressLine2: string | null };
    };
    expect(sent.data.addressLine2).toBe("Unit 204");
  });

  it("sends null when the optional unit line is cleared before saving", () => {
    render(<NewBookingPage />);
    const unitInput = screen.getByLabelText(/Unit \/ suite \/ apartment/);
    fireEvent.change(unitInput, { target: { value: "Suite 5" } });
    fireEvent.change(unitInput, { target: { value: "" } });
    fireEvent.click(screen.getByTestId("button-save-booking"));

    const sent = createBookingMutate.mock.calls[0]![0] as {
      data: { addressLine2: string | null };
    };
    expect(sent.data.addressLine2).toBeNull();
  });
});

describe("the Edmonton default", () => {
  it("starts a new booking in Edmonton, Alberta, and saves it untouched", () => {
    render(<NewBookingPage />);
    expect(screen.getByLabelText("City")).toHaveValue("Edmonton");

    fireEvent.change(screen.getByLabelText("First name"), {
      target: { value: "Jay" },
    });
    fireEvent.click(screen.getByTestId("button-save-booking"));

    const sent = createBookingMutate.mock.calls[0]![0] as {
      data: { addressCity: string | null; addressProvince: string | null };
    };
    expect(sent.data.addressCity).toBe("Edmonton");
    expect(sent.data.addressProvince).toBe("AB");
  });

  it("lets a city read off the call replace the default", async () => {
    captureFixture = listeningCapture(
      "Hi, it's Jay Smith calling from St. Albert",
    );
    draftFromText.mockResolvedValue({ addressCity: "St. Albert" } as never);
    render(<NewBookingPage />);

    expect(screen.getByLabelText("City")).toHaveValue("Edmonton");
    fireEvent.click(screen.getByRole("button", { name: "Read it again" }));
    await act(async () => {});

    // The default was a placeholder; what the caller actually said wins.
    expect(screen.getByLabelText("City")).toHaveValue("St. Albert");
  });

  it("never lets the call overwrite a city the dispatcher typed", async () => {
    captureFixture = listeningCapture(
      "Hi, it's Jay Smith calling from St. Albert",
    );
    draftFromText.mockResolvedValue({ addressCity: "St. Albert" } as never);
    render(<NewBookingPage />);

    fireEvent.change(screen.getByLabelText("City"), {
      target: { value: "Leduc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Read it again" }));
    await act(async () => {});

    expect(screen.getByLabelText("City")).toHaveValue("Leduc");
  });

  it("keeps a cleared city cleared — the default never comes back", () => {
    render(<NewBookingPage />);
    fireEvent.change(screen.getByLabelText("City"), {
      target: { value: "" },
    });
    expect(screen.getByLabelText("City")).toHaveValue("");
  });
});

describe("the month beside the map", () => {
  it("shows what is already booked, and pins the booking on the day you tap", () => {
    monthBookings = [
      {
        bookingId: 7,
        customerName: "Dana Okoro",
        scheduledFor: "2026-08-13T16:00:00.000Z",
      },
    ];
    render(<NewBookingPage />);

    const glance = screen.getByTestId("month-glance");
    // 10am Edmonton on the 13th — the company's day, not the browser's.
    expect(within(glance).getByLabelText(/2026-08-13, 1 job/)).toBeVisible();

    fireEvent.click(screen.getByTestId("glance-day-2026-08-13"));
    expect(screen.getByLabelText(/^Calendar/)).toHaveValue("2026-08-13");
    expect(within(glance).getByTestId("glance-focus-day")).toHaveTextContent(
      "Dana Okoro",
    );
  });
});

describe("clearing the transcript", () => {
  it("offers the words and the clear control on the Phone call tab", () => {
    captureFixture = listeningCapture("Hi, it's Jay, 5810 Mullen Place");
    render(<NewBookingPage />);

    // Still on the Phone call tab — the microphone session belongs to the
    // whole app, so its words and its buttons must be reachable from here.
    expect(screen.getByTestId("text-transcript")).toHaveTextContent(
      "5810 Mullen Place",
    );
    fireEvent.click(screen.getByTestId("button-clear-transcript"));
    expect(clearWords).toHaveBeenCalledTimes(1);
  });

  it("won't offer to clear an empty transcript", () => {
    captureFixture = listeningCapture("");
    render(<NewBookingPage />);
    expect(screen.getByTestId("button-clear-transcript")).toBeDisabled();
  });

  it("leaves everything already filled in alone", () => {
    captureFixture = listeningCapture("Hi, it's Jay");
    render(<NewBookingPage />);

    fireEvent.change(screen.getByLabelText("First name"), {
      target: { value: "Jay" },
    });
    fireEvent.click(screen.getByTestId("button-clear-transcript"));

    // Clearing the screen mid-booking must not cost the booking.
    expect(screen.getByLabelText("First name")).toHaveValue("Jay");
    expect(screen.getByTestId("button-save-booking")).toBeEnabled();
  });
});

describe("an answer that arrives after Clear words", () => {
  /** The mic scan button on the Computer mic tab. */
  const readItAgain = () =>
    screen.getByRole("button", { name: "Read it again" });

  it("drops a slow draft that lands after the transcript was cleared", async () => {
    captureFixture = listeningCapture("Hi, it's Jay Smith, 5810 Mullen Place");
    let resolveDraft!: (draft: unknown) => void;
    draftFromText.mockReturnValue(
      new Promise((resolve) => {
        resolveDraft = resolve;
      }) as never,
    );
    render(<NewBookingPage />);

    // The dispatcher asks for a read, presses Clear before the answer comes
    // back — the next caller is already talking — and only then does the
    // first caller's draft arrive.
    fireEvent.click(readItAgain());
    fireEvent.click(screen.getByTestId("button-clear-transcript"));
    await act(async () => {
      resolveDraft({
        customerName: "Jay Smith",
        customerPhone: "780-555-1234",
        customerAddress: "5810 Mullen Place",
      });
    });

    // None of the previous caller's details may land in the new booking.
    expect(screen.getByLabelText("First name")).toHaveValue("");
    expect(screen.getByLabelText("Last name")).toHaveValue("");
    expect(screen.getByLabelText("Phone number")).toHaveValue("");
    expect(screen.getByLabelText("Street address")).toHaveValue("");
    // And no "Filled in N boxes" popup claiming it did.
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("still fills the boxes when nothing was cleared", async () => {
    captureFixture = listeningCapture("Hi, it's Jay Smith, 5810 Mullen Place");
    let resolveDraft!: (draft: unknown) => void;
    draftFromText.mockReturnValue(
      new Promise((resolve) => {
        resolveDraft = resolve;
      }) as never,
    );
    render(<NewBookingPage />);

    fireEvent.click(readItAgain());
    await act(async () => {
      resolveDraft({
        customerName: "Jay Smith",
        customerPhone: "780-555-1234",
        customerAddress: "5810 Mullen Place",
      });
    });

    // The guard must only bite after a clear — a normal answer still lands.
    expect(screen.getByLabelText("First name")).toHaveValue("Jay");
    expect(screen.getByLabelText("Last name")).toHaveValue("Smith");
    expect(screen.getByLabelText("Phone number")).toHaveValue("780-555-1234");
    expect(screen.getByLabelText("Street address")).toHaveValue(
      "5810 Mullen Place",
    );
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Filled in 3 boxes" }),
    );
  });
});

describe("saving a booking that isn't finished", () => {
  it("saves on a name alone, naming what is missing", () => {
    render(<NewBookingPage />);
    // Nothing is required by default beyond the prefilled date — the owner
    // decides what's required in Settings → Booking form, and this company
    // hasn't toggled anything on.
    const save = screen.getByTestId("button-save-booking");
    expect(save).toBeEnabled();

    fireEvent.change(screen.getByLabelText("First name"), {
      target: { value: "Jay" },
    });
    expect(save).toBeEnabled();
    expect(screen.getByTestId("text-missing-details")).toHaveTextContent(
      "Saving without a phone number or an address or a service",
    );
  });

  it("stops naming gaps once they're filled", () => {
    render(<NewBookingPage />);
    fireEvent.change(screen.getByLabelText("First name"), {
      target: { value: "Jay" },
    });
    fireEvent.change(screen.getByLabelText("Phone number"), {
      target: { value: "780-920-6391" },
    });
    fireEvent.change(screen.getByLabelText("Street address"), {
      target: { value: "5810 Mullen Place" },
    });
    expect(screen.getByTestId("text-missing-details")).toHaveTextContent(
      "Saving without a service",
    );
  });

  it("holds the Save button when the owner toggled a field required", () => {
    companyFixture = {
      timezone: "America/Edmonton",
      bookingRequiredFields: ["phone", "address"],
    };
    render(<NewBookingPage />);
    fireEvent.change(screen.getByLabelText("First name"), {
      target: { value: "Jay" },
    });

    // The gate names exactly what the owner's settings still demand…
    expect(screen.getByTestId("button-save-booking")).toBeDisabled();
    expect(screen.getByTestId("text-required-missing")).toHaveTextContent(
      "Still needs phone, address — required in your Settings.",
    );

    // …and lifts the moment those boxes are filled.
    fireEvent.change(screen.getByLabelText("Phone number"), {
      target: { value: "780-920-6391" },
    });
    fireEvent.change(screen.getByLabelText("Street address"), {
      target: { value: "5810 Mullen Place" },
    });
    expect(screen.getByTestId("button-save-booking")).toBeEnabled();
  });

  it("takes a booking with no start time and says where it will land", () => {
    render(<NewBookingPage />);
    fireEvent.change(screen.getByLabelText("First name"), {
      target: { value: "Jay" },
    });
    fireEvent.change(screen.getByLabelText("Start time"), {
      target: { value: "" },
    });

    expect(screen.getByTestId("button-save-booking")).toBeEnabled();
    expect(screen.getByTestId("text-missing-details")).toHaveTextContent(
      "a start time (it'll go down as 9:00 AM)",
    );
  });
});

describe("typing the date instead of picking it", () => {
  const TZ = "America/Edmonton";
  const wordingBox = () => screen.getByLabelText(/^Date/);
  const calendarBox = () => screen.getByLabelText(/^Calendar/);

  it("lands wording that names a day on the calendar, and says which day", () => {
    render(<NewBookingPage />);
    fireEvent.change(wordingBox(), { target: { value: "tomorrow" } });

    const expected = resolveTypedDate("tomorrow", TZ)!;
    expect(calendarBox()).toHaveValue(expected);
    expect(screen.getByTestId("text-date-resolved")).toHaveTextContent(
      `Lands on ${formatDateWords(expected)}.`,
    );
  });

  it("never blocks a save on vague wording — it keeps the caller's words instead", () => {
    render(<NewBookingPage />);
    fireEvent.change(screen.getByLabelText("First name"), {
      target: { value: "Jay" },
    });
    fireEvent.change(wordingBox(), {
      target: { value: "sometime in September" },
    });

    // The owner is told before saving: no day, the words are kept.
    expect(screen.getByTestId("text-date-unresolved")).toHaveTextContent(
      "Asked for: sometime in September",
    );

    const save = screen.getByTestId("button-save-booking");
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(createBookingMutate).toHaveBeenCalledTimes(1);
    const sent = createBookingMutate.mock.calls[0]![0] as {
      data: { internalNotes: string | null; scheduledFor: string };
    };
    // The exact words ride on the booking, and the schedule still gets its
    // placeholder day — vagueness costs nothing.
    expect(sent.data.internalNotes).toContain(
      "Asked for: sometime in September",
    );
    expect(sent.data.scheduledFor).toBeTruthy();
  });

  it("lets the calendar win once the owner picks a day there", () => {
    render(<NewBookingPage />);
    fireEvent.change(wordingBox(), { target: { value: "tomorrow" } });
    fireEvent.change(calendarBox(), { target: { value: "2026-09-01" } });

    // Resolved wording was only a shortcut to the calendar — once the owner
    // picks for themselves it clears rather than sitting there contradicting
    // the schedule.
    expect(calendarBox()).toHaveValue("2026-09-01");
    expect(wordingBox()).toHaveValue("");
  });

  it("doesn't write an Asked-for note for wording that resolved to a day", () => {
    render(<NewBookingPage />);
    fireEvent.change(screen.getByLabelText("First name"), {
      target: { value: "Jay" },
    });
    fireEvent.change(wordingBox(), { target: { value: "tomorrow" } });
    fireEvent.click(screen.getByTestId("button-save-booking"));

    const sent = createBookingMutate.mock.calls[0]![0] as {
      data: { internalNotes: string | null };
    };
    expect(sent.data.internalNotes).toBeNull();
  });
});
