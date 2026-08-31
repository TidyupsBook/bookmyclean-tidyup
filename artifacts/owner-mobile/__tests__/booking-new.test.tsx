// @vitest-environment jsdom
/**
 * The mobile New Booking screen: prefills from the lead (clean values into
 * structured boxes, free text into the notes, the requested date never
 * parsed), saves in the company timezone, and marks the lead converted with
 * the new booking's id.
 *
 * Quote mode (intent=quote): the Pricing card appears, hours + rate are
 * required, they are included in the create payload, and on success the screen
 * navigates to the booking detail with sendQuote=1 instead of going back.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";

// --- Mocks: strip Expo-native modules and the generated API hooks ----------

vi.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@/components/Brand", () => ({
  BrandHeaderTitle: () => null,
}));

vi.mock("@/components/StateViews", () => ({
  LoadingView: () => null,
  ErrorView: () => null,
  EmptyView: () => null,
}));

const routerBack = vi.fn();
const routerReplace = vi.fn();
// Mutable so tests can switch between booking-mode and quote-mode params.
const routerParams = vi.hoisted(() => ({
  current: { leadId: "7" } as Record<string, string>,
}));
vi.mock("expo-router", () => ({
  useRouter: () => ({
    back: routerBack,
    push: vi.fn(),
    replace: routerReplace,
  }),
  useLocalSearchParams: () => routerParams.current,
  useNavigation: () => ({ addListener: vi.fn(() => vi.fn()) }),
}));

const createMutate = vi.fn();
const convertMutate = vi.fn();
const invalidateQueries = vi.fn();

const hooks = vi.hoisted(() => ({
  lead: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  company: {
    data: { timezone: "America/Edmonton" } as unknown,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  services: {
    data: [{ name: "Deep Clean" }, { name: "Standard Clean" }],
    isLoading: false,
    isError: false,
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  // Keep the hand-written helpers (bookingDisplayName, missingBookingFields,
  // ...) real — they are pure functions the screens under test lean on.
  ...(await importOriginal<Record<string, unknown>>()),
  useGetCompany: () => hooks.company,
  useListServices: () => hooks.services,
  useGetLead: () => hooks.lead,
  useCreateBooking: () => ({ mutate: createMutate, isPending: false }),
  useConvertLead: () => ({ mutate: convertMutate, isPending: false }),
  // These tests are about the lead → booking flow; the live-call panel is
  // proven in booking-live-capture.test.tsx, so this user can't take calls.
  useGetCurrentUser: () => ({ data: { canTakeLiveCalls: false } }),
  useDraftBookingFromText: () => ({ mutate: vi.fn(), isPending: false }),
  // callId-linked call — no callId in these tests so this is never queried.
  useGetCall: () => ({ data: undefined, isLoading: false }),
  getCallBookingDraft: vi.fn(),
  getGetCallQueryKey: (id: number) => ["/calls", id],
  getGetLeadQueryKey: (id: number) => ["/api/leads", id],
  getListLeadsQueryKey: () => ["/leads"],
  getListBookingsQueryKey: () => ["/bookings"],
  getGetDashboardSummaryQueryKey: () => ["/dashboard/summary"],
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries }),
  // useMutation is used directly by the scanCall (getCallBookingDraft) logic.
  // No callId in these tests so the mutate is never called, but the hook
  // must exist so the component can render.
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

import NewBookingScreen from "@/app/booking/new";

// --- Fixtures ---------------------------------------------------------------

const lead = {
  id: 7,
  externalId: "s7",
  source: "sheet",
  sourceTab: "Spring",
  status: "new",
  name: "Jane Doe",
  phoneDisplay: "(780) 555-0188",
  phoneE164: "+17805550188",
  email: "jane@example.com",
  service: "Deep Clean",
  bedrooms: "3",
  bathrooms: "1 or 2", // free text — must land in notes, not the box
  dateOfServiceRequested: "this weekend?",
  streetAddress: "123 Main St",
  city: "Edmonton",
  province: "AB",
  postCode: "T5J 0K7",
  platform: "fb",
  campaignName: "Spring Promo",
  createdAt: new Date().toISOString(),
};

beforeEach(() => {
  hooks.lead.data = lead;
  hooks.lead.isLoading = false;
  hooks.lead.isError = false;
  // Default: normal booking mode with lead prefill.
  routerParams.current = { leadId: "7" };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NewBookingScreen", () => {
  it("prefills the form from the lead, keeping free text out of numeric boxes", () => {
    const { getByTestId } = render(<NewBookingScreen />);
    expect((getByTestId("input-name") as HTMLInputElement).value).toBe(
      "Jane Doe",
    );
    expect((getByTestId("input-phone") as HTMLInputElement).value).toBe(
      "+17805550188",
    );
    expect((getByTestId("input-street") as HTMLInputElement).value).toBe(
      "123 Main St",
    );
    expect((getByTestId("input-service") as HTMLInputElement).value).toBe(
      "Deep Clean",
    );
    expect((getByTestId("input-bedrooms") as HTMLInputElement).value).toBe("3");
    // "1 or 2" is not a number — the box stays empty…
    expect((getByTestId("input-bathrooms") as HTMLInputElement).value).toBe("");
    // …and the raw text (plus the never-parsed requested date) is in notes.
    const notes = (getByTestId("input-notes") as HTMLTextAreaElement).value;
    expect(notes).toContain("Bathrooms: 1 or 2");
    expect(notes).toContain("Asked for: this weekend?");
    expect(notes).toContain("From lead ad (fb · Spring Promo)");
  });

  it("keeps the repaired lead contact details in quote mode", () => {
    routerParams.current = { leadId: "7", intent: "quote" };
    hooks.lead.data = {
      ...lead,
      phoneDisplay: "780-555-0199",
      phoneE164: "+17805550199",
      email: "repaired@example.com",
    };

    const { getByTestId } = render(<NewBookingScreen />);

    expect(getByTestId("input-quote-hours")).toBeTruthy();
    expect((getByTestId("input-name") as HTMLInputElement).value).toBe(
      "Jane Doe",
    );
    expect((getByTestId("input-phone") as HTMLInputElement).value).toBe(
      "+17805550199",
    );
    expect((getByTestId("input-email") as HTMLInputElement).value).toBe(
      "repaired@example.com",
    );
  });

  it("starts in Edmonton, Alberta when the lead names no city or province", () => {
    hooks.lead.data = { ...lead, city: null, province: null };
    const { getByTestId } = render(<NewBookingScreen />);
    expect((getByTestId("input-city") as HTMLInputElement).value).toBe(
      "Edmonton",
    );
    expect((getByTestId("input-province") as HTMLInputElement).value).toBe(
      "AB",
    );
  });

  it("lets the lead's own city and province replace the Edmonton default", () => {
    hooks.lead.data = { ...lead, city: "Calgary", province: "SK" };
    const { getByTestId } = render(<NewBookingScreen />);
    expect((getByTestId("input-city") as HTMLInputElement).value).toBe(
      "Calgary",
    );
    expect((getByTestId("input-province") as HTMLInputElement).value).toBe(
      "SK",
    );
  });

  it("keeps the defaults editable — typing wins and they don't come back", () => {
    hooks.lead.data = { ...lead, city: null, province: null };
    const { getByTestId } = render(<NewBookingScreen />);
    fireEvent.change(getByTestId("input-city"), {
      target: { value: "Leduc" },
    });
    expect((getByTestId("input-city") as HTMLInputElement).value).toBe("Leduc");
  });

  it("saves the booking in the company timezone and converts the lead", async () => {
    const { getByTestId } = render(<NewBookingScreen />);
    fireEvent.change(getByTestId("input-date"), {
      target: { value: "2026-08-20" },
    });
    fireEvent.change(getByTestId("input-time"), {
      target: { value: "10:00" },
    });
    fireEvent.click(getByTestId("save-booking-button"));

    await waitFor(() => expect(createMutate).toHaveBeenCalled());
    const [payload, callbacks] = createMutate.mock.calls[0];
    expect(payload.data.customerName).toBe("Jane Doe");
    expect(payload.data.service).toBe("Deep Clean");
    // 10:00 in Edmonton (MDT, UTC-6) is 16:00Z.
    expect(payload.data.scheduledFor).toBe("2026-08-20T16:00:00.000Z");

    callbacks.onSuccess({ id: 42 });
    expect(convertMutate).toHaveBeenCalledWith(
      { id: 7, data: { bookingId: 42 } },
      expect.anything(),
    );
    // Only after the convert settles does the screen leave.
    const convertCallbacks = convertMutate.mock.calls[0][1];
    convertCallbacks.onSuccess();
    expect(invalidateQueries).toHaveBeenCalled();
    expect(routerBack).toHaveBeenCalled();
  });

  it("saves an entered unit line on a new booking", async () => {
    const { getByTestId } = render(<NewBookingScreen />);
    fireEvent.change(getByTestId("input-address-line-2"), {
      target: { value: "Unit 204" },
    });
    fireEvent.change(getByTestId("input-date"), {
      target: { value: "2026-08-20" },
    });
    fireEvent.click(getByTestId("save-booking-button"));

    await waitFor(() => expect(createMutate).toHaveBeenCalled());
    const [payload] = createMutate.mock.calls[0];
    expect(payload.data.addressLine2).toBe("Unit 204");
  });

  it("sends null when the unit line is cleared before a new booking is saved", async () => {
    const { getByTestId } = render(<NewBookingScreen />);
    const unitInput = getByTestId("input-address-line-2");
    fireEvent.change(unitInput, { target: { value: "Suite 5" } });
    fireEvent.change(unitInput, { target: { value: "" } });
    fireEvent.change(getByTestId("input-date"), {
      target: { value: "2026-08-20" },
    });
    fireEvent.click(getByTestId("save-booking-button"));

    await waitFor(() => expect(createMutate).toHaveBeenCalled());
    const [payload] = createMutate.mock.calls[0];
    expect(payload.data.addressLine2).toBeNull();
  });

  const saveAndFailConvert = async (error: unknown) => {
    const utils = render(<NewBookingScreen />);
    fireEvent.change(utils.getByTestId("input-date"), {
      target: { value: "2026-08-20" },
    });
    fireEvent.click(utils.getByTestId("save-booking-button"));
    await waitFor(() => expect(createMutate).toHaveBeenCalled());
    const { act } = await import("@testing-library/react");
    act(() => {
      createMutate.mock.calls[0][1].onSuccess({ id: 42 });
      convertMutate.mock.calls[0][1].onError(error);
    });
    return utils;
  };

  it("stays on screen with a retry when converting the lead fails", async () => {
    const utils = await saveAndFailConvert(new Error("network down"));
    // No exit of any kind: the failure is visible, and neither a back
    // control nor a leave shortcut is on offer — only retry.
    expect(routerBack).not.toHaveBeenCalled();
    expect(utils.getByTestId("convert-failed")).toBeTruthy();
    expect(utils.queryByTestId("back-button")).toBeNull();
    expect(utils.queryByTestId("leave-unconverted-button")).toBeNull();
    expect(utils.queryByTestId("acknowledge-conflict-button")).toBeNull();

    // Retry fires the convert again with the same booking id.
    fireEvent.click(utils.getByTestId("retry-convert-button"));
    expect(convertMutate).toHaveBeenCalledTimes(2);
    expect(convertMutate.mock.calls[1][0]).toEqual({
      id: 7,
      data: { bookingId: 42 },
    });
    const { act } = await import("@testing-library/react");
    act(() => convertMutate.mock.calls[1][1].onSuccess());
    expect(routerBack).toHaveBeenCalled();
  });

  it("removes the back control after saving, so a pending conversion can't be skipped", async () => {
    const utils = render(<NewBookingScreen />);
    fireEvent.change(utils.getByTestId("input-date"), {
      target: { value: "2026-08-20" },
    });
    expect(utils.getByTestId("back-button")).toBeTruthy();
    fireEvent.click(utils.getByTestId("save-booking-button"));
    await waitFor(() => expect(createMutate).toHaveBeenCalled());
    const { act } = await import("@testing-library/react");
    // Booking saved, conversion still in flight: the header back control is
    // gone, so the user cannot leave before the outcome is known…
    act(() => createMutate.mock.calls[0][1].onSuccess({ id: 42 }));
    expect(utils.queryByTestId("back-button")).toBeNull();
    expect(routerBack).not.toHaveBeenCalled();
    // …and when the conversion then fails, the retry UI is right there.
    act(() => convertMutate.mock.calls[0][1].onError(new Error("boom")));
    expect(utils.getByTestId("convert-failed")).toBeTruthy();
    expect(utils.getByTestId("retry-convert-button")).toBeTruthy();
    expect(routerBack).not.toHaveBeenCalled();
  });

  it("treats an already-converted lead (409) as terminal — acknowledge, no retry", async () => {
    const utils = await saveAndFailConvert({ status: 409 });
    expect(routerBack).not.toHaveBeenCalled();
    expect(utils.getByTestId("convert-conflict")).toBeTruthy();
    expect(utils.queryByTestId("retry-convert-button")).toBeNull();
    fireEvent.click(utils.getByTestId("acknowledge-conflict-button"));
    expect(routerBack).toHaveBeenCalled();
  });

  it("rejects a malformed date instead of guessing", () => {
    const { getByTestId, queryByTestId } = render(<NewBookingScreen />);
    fireEvent.change(getByTestId("input-date"), {
      target: { value: "next tuesday" },
    });
    fireEvent.click(getByTestId("save-booking-button"));
    expect(createMutate).not.toHaveBeenCalled();
    expect(queryByTestId("form-error")).toBeTruthy();
  });
});

describe("NewBookingScreen — quote mode (intent=quote)", () => {
  beforeEach(() => {
    routerParams.current = { leadId: "7", intent: "quote" };
  });

  it("shows the Pricing card in quote mode but not in booking mode", () => {
    const quoteUtils = render(<NewBookingScreen />);
    expect(quoteUtils.queryByTestId("input-quote-hours")).toBeTruthy();
    expect(quoteUtils.queryByTestId("input-quote-rate")).toBeTruthy();
    cleanup();

    routerParams.current = { leadId: "7" };
    const bookingUtils = render(<NewBookingScreen />);
    expect(bookingUtils.queryByTestId("input-quote-hours")).toBeNull();
    expect(bookingUtils.queryByTestId("input-quote-rate")).toBeNull();
  });

  it("blocks save when hours are missing in quote mode", () => {
    const { getByTestId, queryByTestId } = render(<NewBookingScreen />);
    fireEvent.change(getByTestId("input-date"), {
      target: { value: "2026-08-20" },
    });
    // Rate set but hours missing.
    fireEvent.change(getByTestId("input-quote-rate"), {
      target: { value: "55" },
    });
    fireEvent.click(getByTestId("save-booking-button"));
    expect(createMutate).not.toHaveBeenCalled();
    expect(queryByTestId("form-error")).toBeTruthy();
  });

  it("blocks save when rate is missing in quote mode", () => {
    const { getByTestId, queryByTestId } = render(<NewBookingScreen />);
    fireEvent.change(getByTestId("input-date"), {
      target: { value: "2026-08-20" },
    });
    // Hours set but rate missing.
    fireEvent.change(getByTestId("input-quote-hours"), {
      target: { value: "3" },
    });
    fireEvent.click(getByTestId("save-booking-button"));
    expect(createMutate).not.toHaveBeenCalled();
    expect(queryByTestId("form-error")).toBeTruthy();
  });

  it("includes quote fields in the create payload when both hours and rate are set", async () => {
    const { getByTestId } = render(<NewBookingScreen />);
    fireEvent.change(getByTestId("input-date"), {
      target: { value: "2026-08-20" },
    });
    fireEvent.change(getByTestId("input-quote-hours"), {
      target: { value: "3" },
    });
    fireEvent.change(getByTestId("input-quote-rate"), {
      target: { value: "55" },
    });
    fireEvent.change(getByTestId("input-quote-deposit"), {
      target: { value: "100" },
    });
    fireEvent.click(getByTestId("save-booking-button"));

    await waitFor(() => expect(createMutate).toHaveBeenCalled());
    const [payload] = createMutate.mock.calls[0];
    expect(payload.data.quoteHours).toBe(3);
    expect(payload.data.quoteHourlyRate).toBe(55);
    expect(payload.data.quoteDeposit).toBe(100);
  });

  it("omits quoteDeposit when deposit is blank", async () => {
    const { getByTestId } = render(<NewBookingScreen />);
    fireEvent.change(getByTestId("input-date"), {
      target: { value: "2026-08-20" },
    });
    fireEvent.change(getByTestId("input-quote-hours"), {
      target: { value: "2" },
    });
    fireEvent.change(getByTestId("input-quote-rate"), {
      target: { value: "60" },
    });
    fireEvent.click(getByTestId("save-booking-button"));

    await waitFor(() => expect(createMutate).toHaveBeenCalled());
    const [payload] = createMutate.mock.calls[0];
    expect(payload.data.quoteDeposit).toBeNull();
  });

  it("preserves an explicit zero deposit — waiving the deposit is not the same as blank", async () => {
    const { getByTestId } = render(<NewBookingScreen />);
    fireEvent.change(getByTestId("input-date"), {
      target: { value: "2026-08-20" },
    });
    fireEvent.change(getByTestId("input-quote-hours"), {
      target: { value: "2" },
    });
    fireEvent.change(getByTestId("input-quote-rate"), {
      target: { value: "60" },
    });
    fireEvent.change(getByTestId("input-quote-deposit"), {
      target: { value: "0" },
    });
    fireEvent.click(getByTestId("save-booking-button"));

    await waitFor(() => expect(createMutate).toHaveBeenCalled());
    const [payload] = createMutate.mock.calls[0];
    // 0 must be sent as 0, not coerced to null (which would apply the company
    // default and charge a deposit the owner just waived).
    expect(payload.data.quoteDeposit).toBe(0);
  });

  it("hour chips set the hours field", () => {
    const { getByTestId } = render(<NewBookingScreen />);
    fireEvent.click(getByTestId("quote-hours-chip-3"));
    expect((getByTestId("input-quote-hours") as HTMLInputElement).value).toBe(
      "3",
    );
  });

  it("navigates to the booking detail with sendQuote=1 after successful save+convert", async () => {
    const { getByTestId } = render(<NewBookingScreen />);
    fireEvent.change(getByTestId("input-date"), {
      target: { value: "2026-08-20" },
    });
    fireEvent.change(getByTestId("input-quote-hours"), {
      target: { value: "3" },
    });
    fireEvent.change(getByTestId("input-quote-rate"), {
      target: { value: "55" },
    });
    fireEvent.click(getByTestId("save-booking-button"));

    await waitFor(() => expect(createMutate).toHaveBeenCalled());
    const { act } = await import("@testing-library/react");
    act(() => createMutate.mock.calls[0][1].onSuccess({ id: 99 }));
    act(() => convertMutate.mock.calls[0][1].onSuccess());

    // Quote mode → router.replace to booking detail, NOT router.back.
    expect(routerBack).not.toHaveBeenCalled();
    expect(routerReplace).toHaveBeenCalledWith({
      pathname: "/booking/[id]",
      params: { id: "99", sendQuote: "1" },
    });
  });

  it("stays on screen with retry when convert fails in quote mode", async () => {
    const { getByTestId, queryByTestId } = render(<NewBookingScreen />);
    fireEvent.change(getByTestId("input-date"), {
      target: { value: "2026-08-20" },
    });
    fireEvent.change(getByTestId("input-quote-hours"), {
      target: { value: "2" },
    });
    fireEvent.change(getByTestId("input-quote-rate"), {
      target: { value: "55" },
    });
    fireEvent.click(getByTestId("save-booking-button"));

    await waitFor(() => expect(createMutate).toHaveBeenCalled());
    const { act } = await import("@testing-library/react");
    act(() => {
      createMutate.mock.calls[0][1].onSuccess({ id: 77 });
      convertMutate.mock.calls[0][1].onError(new Error("network"));
    });

    expect(queryByTestId("convert-failed")).toBeTruthy();
    expect(routerBack).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();

    // Retry succeeds → navigates to booking detail with sendQuote=1.
    fireEvent.click(getByTestId("retry-convert-button"));
    act(() => convertMutate.mock.calls[1][1].onSuccess());
    expect(routerReplace).toHaveBeenCalledWith({
      pathname: "/booking/[id]",
      params: { id: "77", sendQuote: "1" },
    });
  });
});
