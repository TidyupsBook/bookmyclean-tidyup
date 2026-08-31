// @vitest-environment jsdom
/**
 * The Leads screen: new leads render with contact info, Dismiss shows only
 * on `new` leads and fires the dismiss mutation, tapping the phone button
 * dials the lead, and the filter chips change which status is requested.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  render,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";

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
const routerPush = vi.fn();
const navigation = vi.hoisted(() => ({
  focusEffect: null as null | (() => void),
}));
const storedFilters = vi.hoisted(() => ({
  value: null as string | null,
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(() => Promise.resolve(storedFilters.value)),
    setItem: vi.fn((_key: string, value: string) => {
      storedFilters.value = value;
      return Promise.resolve();
    }),
  },
}));
vi.mock("expo-router", () => ({
  useRouter: () => ({ back: routerBack, push: routerPush }),
  useFocusEffect: (effect: () => void) => {
    navigation.focusEffect = effect;
  },
}));

// react-native is aliased to react-native-web in vitest.config.ts; spy on
// its Linking and Alert rather than mocking the whole module.
import { AppState, Linking, Alert } from "react-native";
const openURL = vi
  .spyOn(Linking, "openURL")
  .mockResolvedValue(undefined as never);
const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});

const dismissMutate = vi.fn();
const updateContactMutate = vi.fn();
const listLeadsCalls: unknown[] = [];

const hooks = vi.hoisted(() => ({
  leads: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
  },
  syncStatus: {
    data: undefined as unknown,
    isRefetching: false,
    refetch: vi.fn(),
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react")>()),
  useListLeads: (params: unknown) => {
    listLeadsCalls.push(params);
    return hooks.leads;
  },
  useGetLeadSyncStatus: () => hooks.syncStatus,
  useDismissLead: () => ({ mutate: dismissMutate, isPending: false }),
  useUpdateLeadContact: () => ({
    mutate: updateContactMutate,
    isPending: false,
  }),
  getListLeadsQueryKey: () => ["/leads"],
  getGetLeadQueryKey: (id: number) => ["/api/leads", id],
  getGetDashboardSummaryQueryKey: () => ["/dashboard/summary"],
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
}));

import LeadsScreen, { resetRetainedLeadFiltersForTest } from "@/app/leads";

// --- Fixtures ---------------------------------------------------------------

const newLead = {
  id: 1,
  externalId: "s1",
  source: "sheet",
  sourceTab: "Spring",
  status: "new",
  name: "Jane Doe",
  phoneDisplay: "(780) 555-0188",
  phoneE164: "+17805550188",
  email: "jane@example.com",
  service: "Deep clean",
  bedrooms: "3",
  bathrooms: "2",
  city: "Edmonton",
  province: "AB",
  createdAt: new Date().toISOString(),
};

const convertedLead = {
  ...newLead,
  id: 2,
  name: "Bob Booked",
  status: "converted",
  convertedBookingId: 42,
};

const googleLead = {
  ...newLead,
  id: 5,
  name: "Grace Sheet",
  source: "sheet" as const,
};

const websiteLead = {
  ...newLead,
  id: 6,
  name: "Wendy Website",
  source: "form" as const,
};

/** Lead with no phone at all — the sheet row had nothing. */
const noPhoneLead = {
  ...newLead,
  id: 3,
  name: "No Phone Person",
  phoneDisplay: "",
  phoneE164: null,
  email: null,
};

/** Lead with a display phone but no dialable E.164. */
const undialableLead = {
  ...newLead,
  id: 4,
  name: "Undialable Person",
  phoneDisplay: "not a number",
  phoneE164: null,
  email: "undialable@example.com",
};

/**
 * Lead with a numeric-looking display phone but no E.164.
 * Exercises the case where telHref would previously have accepted the
 * display string and rendered a call button; dial must be gated on E.164.
 */
const numericDisplayLead = {
  ...newLead,
  id: 99,
  name: "Numeric Display Person",
  phoneDisplay: "780-555-0000",
  phoneE164: null,
  email: "numeric@example.com",
};

beforeEach(() => {
  hooks.leads.data = [newLead, convertedLead];
  hooks.syncStatus.data = undefined;
  hooks.leads.isLoading = false;
  hooks.leads.isError = false;
  hooks.leads.isRefetching = false;
  hooks.syncStatus.isRefetching = false;
  navigation.focusEffect = null;
  storedFilters.value = null;
  resetRetainedLeadFiltersForTest();
  listLeadsCalls.length = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("LeadsScreen", () => {
  it("renders leads with contact info", () => {
    const { getByText, getAllByText } = render(<LeadsScreen />);
    expect(getByText("Jane Doe")).toBeTruthy();
    expect(getAllByText("Deep clean · 3 bed · 2 bath").length).toBe(2);
    expect(getAllByText("(780) 555-0188").length).toBeGreaterThan(0);
  });

  it("defaults to the `new` filter", () => {
    render(<LeadsScreen />);
    expect(listLeadsCalls[0]).toEqual({ status: "new" });
  });

  it("passes no status when All is selected", () => {
    const { getByTestId } = render(<LeadsScreen />);
    fireEvent.click(getByTestId("leads-filter-all"));
    expect(listLeadsCalls[listLeadsCalls.length - 1]).toBeUndefined();
  });

  it("dismisses only new leads and fires the mutation", () => {
    const { getByTestId, queryByTestId } = render(<LeadsScreen />);
    expect(queryByTestId("lead-dismiss-2")).toBeNull();
    fireEvent.click(getByTestId("lead-dismiss-1"));
    expect(dismissMutate).toHaveBeenCalledWith({ id: 1 });
  });

  it("offers Create booking on new leads but not converted ones", () => {
    const { getByTestId, queryByTestId } = render(<LeadsScreen />);
    expect(queryByTestId("lead-create-booking-2")).toBeNull();
    fireEvent.click(getByTestId("lead-create-booking-1"));
    expect(routerPush).toHaveBeenCalledWith({
      pathname: "/booking/new",
      params: { leadId: "1" },
    });
  });

  it("offers Create quote on non-converted leads but not converted ones", () => {
    const { getByTestId, queryByTestId } = render(<LeadsScreen />);
    expect(queryByTestId("lead-create-quote-2")).toBeNull();
    fireEvent.click(getByTestId("lead-create-quote-1"));
    expect(routerPush).toHaveBeenCalledWith({
      pathname: "/booking/new",
      params: { leadId: "1", intent: "quote" },
    });
  });

  it("links converted leads to their booking", () => {
    const { getByTestId, queryByTestId } = render(<LeadsScreen />);
    expect(queryByTestId("lead-view-booking-1")).toBeNull();
    fireEvent.click(getByTestId("lead-view-booking-2"));
    expect(routerPush).toHaveBeenCalledWith({
      pathname: "/booking/[id]",
      params: { id: "42" },
    });
  });

  it("dials the lead's phone number", () => {
    const { getByTestId } = render(<LeadsScreen />);
    fireEvent.click(getByTestId("lead-call-1"));
    expect(openURL).toHaveBeenCalledWith("tel:+17805550188");
  });

  it("shows the 'From Google Sheet' source badge on sheet leads", () => {
    const { getByTestId } = render(<LeadsScreen />);
    // newLead fixture has source:"sheet"
    expect(getByTestId("badge-source-sheet-1")).toBeTruthy();
  });

  it("shows readable and failed sheet tabs in the sync status", () => {
    hooks.syncStatus.data = {
      configured: true,
      lastSyncAt: new Date().toISOString(),
      lastSuccessAt: null,
      lastError: "The Spring tab could not be read.",
      warning: null,
      tabStatuses: [
        { name: "Facebook Leads", status: "read" },
        { name: "Spring", status: "failed", error: "Unable to parse range" },
      ],
    };

    const { getByTestId, getByText } = render(<LeadsScreen />);
    expect(getByTestId("lead-sync-tab-results")).toBeTruthy();
    expect(getByTestId("lead-sync-tab-read-Facebook Leads")).toBeTruthy();
    expect(getByTestId("lead-sync-tab-failed-Spring")).toBeTruthy();
    expect(getByText("Read successfully")).toBeTruthy();
    expect(getByText("Read failed")).toBeTruthy();
    expect(getByText("Unable to parse range")).toBeTruthy();
  });

  it("keeps a connector failure separate when no tabs were discovered", () => {
    hooks.syncStatus.data = {
      configured: true,
      lastSyncAt: new Date().toISOString(),
      lastSuccessAt: null,
      lastError: "No google-sheet connection found",
      warning: null,
      tabStatuses: [],
    };

    const { getByText, queryByTestId } = render(<LeadsScreen />);
    expect(getByText("Leads sheet unavailable")).toBeTruthy();
    expect(getByText("No google-sheet connection found")).toBeTruthy();
    expect(queryByTestId("lead-sync-tab-results")).toBeNull();
  });

  it("flags a poller that has stopped advancing", () => {
    hooks.syncStatus.data = {
      configured: true,
      lastSyncAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      lastSuccessAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      lastError: null,
      warning: null,
      stale: true,
      tabStatuses: [],
    };

    const { getByTestId, getByText } = render(<LeadsScreen />);
    expect(getByTestId("lead-sync-stale")).toBeTruthy();
    expect(getByText("Automatic lead sync has stopped")).toBeTruthy();
  });

  it("rechecks leads and status after a stale catch-up window", async () => {
    vi.useFakeTimers();
    hooks.syncStatus.data = {
      configured: true,
      lastSyncAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      lastSuccessAt: null,
      lastError: null,
      warning: null,
      stale: true,
      tabStatuses: [],
    };
    const { unmount } = render(<LeadsScreen />);
    hooks.leads.refetch.mockClear();
    hooks.syncStatus.refetch.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    expect(hooks.leads.refetch).toHaveBeenCalledTimes(1);
    expect(hooks.syncStatus.refetch).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("keeps rechecking while a slow catch-up is still stale", async () => {
    vi.useFakeTimers();
    hooks.syncStatus.data = {
      configured: true,
      lastSyncAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      lastSuccessAt: null,
      lastError: null,
      warning: null,
      stale: true,
      tabStatuses: [],
    };
    const { unmount } = render(<LeadsScreen />);
    hooks.leads.refetch.mockClear();
    hooks.syncStatus.refetch
      .mockReset()
      .mockResolvedValueOnce({ data: { stale: true } })
      .mockResolvedValueOnce({ data: { stale: false } });

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(hooks.syncStatus.refetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(hooks.leads.refetch).toHaveBeenCalledTimes(2);
    expect(hooks.syncStatus.refetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(hooks.syncStatus.refetch).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("shows when readable rows were intentionally skipped", () => {
    hooks.syncStatus.data = {
      configured: true,
      lastSyncAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
      lastError: null,
      warning: null,
      stale: false,
      tabStatuses: [
        {
          name: "FB Leads_V2",
          status: "read",
          rowsSeen: 1,
          eligibleRows: 0,
          importedRows: 0,
          duplicateRows: 0,
          skippedRows: 1,
          eligibilityWarning:
            "1 non-empty row was intentionally skipped because it did not qualify as a lead.",
        },
      ],
    };

    const { getByText } = render(<LeadsScreen />);
    expect(getByText("Some sheet rows were skipped")).toBeTruthy();
    expect(
      getByText("0 qualifying · 0 imported · 0 already seen · 1 skipped"),
    ).toBeTruthy();
    expect(getByText(/intentionally skipped/)).toBeTruthy();
  });

  it("shows neutral copy and no sync details when the sheet is not configured", () => {
    hooks.syncStatus.data = {
      configured: false,
      lastSyncAt: null,
      lastSuccessAt: null,
      lastError: null,
      warning: null,
      stale: false,
      tabStatuses: [],
    };

    const { getByTestId, getByText, queryByText, queryByTestId } = render(
      <LeadsScreen />,
    );
    expect(getByTestId("lead-sync-unconfigured")).toBeTruthy();
    expect(getByText("Google Sheet feed not connected")).toBeTruthy();
    expect(
      getByText(
        "This company isn't connected to the shared Google Sheet lead feed.",
      ),
    ).toBeTruthy();
    expect(queryByText("Automatic lead sync has stopped")).toBeNull();
    expect(queryByText("The sheet has not been checked yet.")).toBeNull();
    expect(queryByTestId("lead-sync-tab-results")).toBeNull();
  });

  it("refreshes leads and sync status when the screen is focused", () => {
    render(<LeadsScreen />);
    hooks.leads.refetch.mockClear();
    hooks.syncStatus.refetch.mockClear();

    act(() => {
      navigation.focusEffect?.();
    });

    expect(hooks.leads.refetch).toHaveBeenCalledTimes(1);
    expect(hooks.syncStatus.refetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the selected source filter through a focus refresh", () => {
    hooks.leads.data = [websiteLead, googleLead];
    const { getByTestId, getByText, queryByText } = render(<LeadsScreen />);
    fireEvent.click(getByTestId("leads-source-filter-sheet"));
    expect(getByText("Grace Sheet")).toBeTruthy();
    expect(queryByText("Wendy Website")).toBeNull();
    hooks.leads.refetch.mockClear();
    hooks.syncStatus.refetch.mockClear();

    act(() => {
      navigation.focusEffect?.();
    });

    expect(getByText("Grace Sheet")).toBeTruthy();
    expect(queryByText("Wendy Website")).toBeNull();
  });

  it("restores selected filters after the route remounts", async () => {
    hooks.leads.data = [websiteLead, googleLead];
    const first = render(<LeadsScreen />);
    fireEvent.click(first.getByTestId("leads-filter-all"));
    fireEvent.click(first.getByTestId("leads-source-filter-sheet"));
    await waitFor(() =>
      expect(storedFilters.value).toContain('"sourceFilter":"sheet"'),
    );
    first.unmount();

    const second = render(<LeadsScreen />);
    await waitFor(() => {
      expect(second.getByText("Grace Sheet")).toBeTruthy();
      expect(second.queryByText("Wendy Website")).toBeNull();
    });
  });

  it("refreshes leads and sync status when the app returns to foreground", () => {
    let onAppStateChange: ((state: string) => void) | undefined;
    const remove = vi.fn();
    const listener = vi
      .spyOn(AppState, "addEventListener")
      .mockImplementation((_event, handler) => {
        onAppStateChange = handler as (state: string) => void;
        return { remove } as never;
      });
    const { unmount } = render(<LeadsScreen />);
    hooks.leads.refetch.mockClear();
    hooks.syncStatus.refetch.mockClear();

    act(() => {
      onAppStateChange?.("active");
    });

    expect(hooks.leads.refetch).toHaveBeenCalledTimes(1);
    expect(hooks.syncStatus.refetch).toHaveBeenCalledTimes(1);
    unmount();
    expect(remove).toHaveBeenCalledTimes(1);
    listener.mockRestore();
  });

  it("does not show a sheet badge on non-sheet leads", () => {
    hooks.leads.data = [
      { ...newLead, id: 5, source: "form", sourceTab: null },
      { ...newLead, id: 6, source: "jobber", sourceTab: null },
    ];
    const { getByTestId, queryByTestId } = render(<LeadsScreen />);
    expect(getByTestId("badge-source-form-5")).toBeTruthy();
    expect(getByTestId("badge-source-jobber-6")).toBeTruthy();
    expect(queryByTestId("badge-source-sheet-5")).toBeNull();
    expect(queryByTestId("badge-source-sheet-6")).toBeNull();
  });

  it("shows a 'No phone' badge when a lead has no phoneE164", () => {
    hooks.leads.data = [noPhoneLead];
    const { getByTestId } = render(<LeadsScreen />);
    expect(getByTestId(`badge-no-phone-${noPhoneLead.id}`)).toBeTruthy();
  });

  it("does not show 'No phone' when the lead has a dialable phone", () => {
    const { queryByTestId } = render(<LeadsScreen />);
    expect(queryByTestId(`badge-no-phone-${newLead.id}`)).toBeNull();
  });

  it("shows a 'No email' badge when a lead has no email", () => {
    hooks.leads.data = [noPhoneLead]; // noPhoneLead also has email: null
    const { getByTestId } = render(<LeadsScreen />);
    expect(getByTestId(`badge-no-email-${noPhoneLead.id}`)).toBeTruthy();
  });

  it("does not show 'No email' when the lead has an email", () => {
    const { queryByTestId } = render(<LeadsScreen />);
    expect(queryByTestId(`badge-no-email-${newLead.id}`)).toBeNull();
  });

  it("tapping 'No phone' opens the edit form for phone", () => {
    hooks.leads.data = [noPhoneLead];
    const { getByTestId } = render(<LeadsScreen />);
    fireEvent.click(getByTestId(`badge-no-phone-${noPhoneLead.id}`));
    expect(getByTestId(`edit-phone-form-${noPhoneLead.id}`)).toBeTruthy();
    expect(getByTestId(`edit-phone-input-${noPhoneLead.id}`)).toBeTruthy();
  });

  it("offers to add a phone instead of navigating when creating a quote without one", () => {
    hooks.leads.data = [noPhoneLead];
    const { getByTestId } = render(<LeadsScreen />);
    fireEvent.click(getByTestId(`lead-create-quote-${noPhoneLead.id}`));
    expect(alertSpy).toHaveBeenCalledWith(
      "Phone number needed",
      expect.any(String),
      expect.any(Array),
    );

    const buttons = alertSpy.mock.calls.at(-1)?.[2];
    expect(buttons?.[0]?.text).toBe("Add phone");
    act(() => {
      buttons?.[0]?.onPress?.();
    });

    expect(getByTestId(`edit-phone-form-${noPhoneLead.id}`)).toBeTruthy();
    expect(getByTestId(`edit-phone-input-${noPhoneLead.id}`)).toBeTruthy();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("tapping 'Create quote' on a lead WITH a phone navigates normally", () => {
    const { getByTestId } = render(<LeadsScreen />);
    fireEvent.click(getByTestId(`lead-create-quote-${newLead.id}`));
    expect(routerPush).toHaveBeenCalledWith({
      pathname: "/booking/new",
      params: { leadId: String(newLead.id), intent: "quote" },
    });
  });

  it("saving the edit form calls updateContact with the entered value", () => {
    hooks.leads.data = [noPhoneLead];
    const { getByTestId } = render(<LeadsScreen />);
    fireEvent.click(getByTestId(`badge-no-phone-${noPhoneLead.id}`));
    fireEvent.change(getByTestId(`edit-phone-input-${noPhoneLead.id}`), {
      target: { value: "780-555-9999" },
    });
    fireEvent.click(getByTestId(`edit-phone-save-${noPhoneLead.id}`));
    expect(updateContactMutate).toHaveBeenCalledWith(
      { id: noPhoneLead.id, data: { phone: "780-555-9999" } },
      expect.any(Object),
    );
  });

  it("unlocks quote creation immediately after saving a missing phone", () => {
    hooks.leads.data = [noPhoneLead];
    const updatedLead = {
      ...noPhoneLead,
      phoneDisplay: "780-555-9999",
      phoneE164: "+17805559999",
    };
    updateContactMutate.mockImplementationOnce(
      (_input, options: { onSuccess: (lead: typeof updatedLead) => void }) => {
        options.onSuccess(updatedLead);
      },
    );

    const { getByTestId, queryByTestId } = render(<LeadsScreen />);
    fireEvent.click(getByTestId(`badge-no-phone-${noPhoneLead.id}`));
    fireEvent.change(getByTestId(`edit-phone-input-${noPhoneLead.id}`), {
      target: { value: "780-555-9999" },
    });
    fireEvent.click(getByTestId(`edit-phone-save-${noPhoneLead.id}`));

    expect(queryByTestId(`badge-no-phone-${noPhoneLead.id}`)).toBeNull();
    expect(getByTestId(`lead-call-${noPhoneLead.id}`)).toBeTruthy();
    fireEvent.click(getByTestId(`lead-create-quote-${noPhoneLead.id}`));
    expect(routerPush).toHaveBeenCalledWith({
      pathname: "/booking/new",
      params: { leadId: String(noPhoneLead.id), intent: "quote" },
    });
  });

  it("shows a 'needs correction' badge when phoneDisplay is set but phoneE164 is null", () => {
    hooks.leads.data = [undialableLead];
    const { getByTestId } = render(<LeadsScreen />);
    // The badge-no-phone testid must be present even when phoneDisplay is non-empty.
    expect(getByTestId(`badge-no-phone-${undialableLead.id}`)).toBeTruthy();
  });

  it("tapping the 'needs correction' badge on an undialable lead opens the phone edit form", () => {
    hooks.leads.data = [undialableLead];
    const { getByTestId } = render(<LeadsScreen />);
    fireEvent.click(getByTestId(`badge-no-phone-${undialableLead.id}`));
    expect(getByTestId(`edit-phone-form-${undialableLead.id}`)).toBeTruthy();
    expect(getByTestId(`edit-phone-input-${undialableLead.id}`)).toBeTruthy();
  });

  it("shows the Called badge with recency only when the server flagged the lead", () => {
    const twoDaysAgo = new Date(
      Date.now() - 2 * 24 * 60 * 60 * 1000,
    ).toISOString();
    hooks.leads.data = [
      { ...newLead, id: 51, hasCalled: true, lastCallAt: twoDaysAgo },
      { ...newLead, id: 52, hasCalled: false, lastCallAt: null },
    ];
    const { getByTestId, getByText, queryByTestId } = render(<LeadsScreen />);
    expect(getByTestId("badge-called-51")).toBeTruthy();
    // The recency rides on the badge so the owner sees how fresh it is.
    expect(getByText(/Called — /)).toBeTruthy();
    expect(queryByTestId("badge-called-52")).toBeNull();
  });

  it("shows correction nudge (not a call button) for a numeric display phone with no E.164", () => {
    hooks.leads.data = [numericDisplayLead];
    const { getByTestId, queryByTestId } = render(<LeadsScreen />);
    // Must NOT render a call button — E.164 is the gating signal, not the display string.
    expect(queryByTestId(`lead-call-${numericDisplayLead.id}`)).toBeNull();
    // Must render the correction nudge so the owner can fix the number.
    expect(getByTestId(`badge-no-phone-${numericDisplayLead.id}`)).toBeTruthy();
  });
});
