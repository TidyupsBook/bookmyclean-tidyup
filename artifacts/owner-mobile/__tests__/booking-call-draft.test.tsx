// @vitest-environment jsdom
/**
 * New Booking screen — "Take booking from this call" path.
 *
 * When the screen is opened with ?callId=<id> by an entitled user, it:
 *   - shows a linked-call status row in the Live call panel;
 *   - polls the call and auto-applies the Quo booking-draft once the caller
 *     hangs up (status leaves "in_progress"), filling only empty boxes;
 *   - offers a manual "Fill from call" button that triggers the same fetch;
 *   - never overwrites a value the owner has already typed;
 *   - hides all of this from users who can't take live calls.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";

// --- Expo / native stubs ------------------------------------------------------

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

// --- Router: always open with callId=42 --------------------------------------

vi.mock("expo-router", () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useLocalSearchParams: () => ({ callId: "42" }),
  useNavigation: () => ({ addListener: vi.fn(() => vi.fn()) }),
}));

// --- react-query: useMutation actually executes the mutationFn + onSuccess ---
// This lets us test that the draft lands in the form without a real QueryClient.

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: (config: {
    mutationFn: (id: number) => Promise<unknown>;
    onSuccess?: (result: unknown) => void;
  }) => {
    const mutate = vi.fn(async (id: number) => {
      const result = await config.mutationFn(id);
      config.onSuccess?.(result);
    });
    return { mutate, isPending: false };
  },
}));

// --- Mutable hook fixtures ----------------------------------------------------

const hooks = vi.hoisted(() => ({
  me: {
    data: { canTakeLiveCalls: true } as unknown,
  },
  company: {
    data: { timezone: "America/Edmonton" } as unknown,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  services: {
    data: [] as { name: string }[],
    isLoading: false,
    isError: false,
  },
  // Mutable so tests can control the linked-call lifecycle.
  linkedCall: {
    data: undefined as
      | undefined
      | {
          id: number;
          status: string;
          summary: string | null;
          serviceRequested?: string;
          preferredTime?: string;
        },
    isLoading: false,
  },
}));

const callDraftMock = vi.hoisted(() => vi.fn());

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useGetCompany: () => hooks.company,
  useListServices: () => hooks.services,
  useGetLead: () => ({ data: undefined, isLoading: false, isError: false }),
  useGetCurrentUser: () => hooks.me,
  useCreateBooking: () => ({ mutate: vi.fn(), isPending: false }),
  useConvertLead: () => ({ mutate: vi.fn(), isPending: false }),
  useDraftBookingFromText: () => ({ mutate: vi.fn(), isPending: false }),
  useGetCall: () => hooks.linkedCall,
  getCallBookingDraft: callDraftMock,
  getGetCallQueryKey: (id: number) => ["/calls", id],
  getListLeadsQueryKey: () => ["/leads"],
  getListBookingsQueryKey: () => ["/bookings"],
  getGetDashboardSummaryQueryKey: () => ["/dashboard/summary"],
}));

// Live capture is irrelevant here — the call-draft path uses getCallBookingDraft,
// not the microphone.
vi.mock("@/lib/live-capture", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useLiveCapture: () => ({
    supported: true,
    status: "idle",
    listening: false,
    starting: false,
    reconnecting: false,
    active: false,
    text: "",
    interim: "",
    error: null,
    stopReason: null,
    failed: false,
    start: vi.fn(),
    stop: vi.fn(),
    clear: vi.fn(),
  }),
}));

import NewBookingScreen from "@/app/booking/new";

// --- Shared draft fixture -----------------------------------------------------

const callDraft = {
  callId: 42,
  customerName: "Janet Caller",
  customerPhone: "780-555-4200",
  customerAddress: "42 Oak Ave",
  addressCity: "St. Albert",
  addressProvince: "AB",
  addressPostal: "T8N 1N3",
  service: "Deep Clean",
  bedrooms: 3,
  bathrooms: 2,
  preferredTime: "next Saturday morning",
  internalNotes: null,
  filledFields: ["customerName"],
};

const emptyDraft = {
  callId: 42,
  customerName: null,
  customerPhone: null,
  customerAddress: null,
  addressCity: null,
  addressProvince: null,
  addressPostal: null,
  service: null,
  bedrooms: null,
  bathrooms: null,
  preferredTime: null,
  internalNotes: null,
  filledFields: [],
};

const inProgressCall = {
  id: 42,
  status: "in_progress",
  summary: null,
  serviceRequested: undefined,
  preferredTime: undefined,
};
// Call just ended — transcript/summary webhooks haven't fired yet.
const completedNoWriteup = {
  id: 42,
  status: "completed",
  summary: null,
  serviceRequested: undefined,
  preferredTime: undefined,
};
// Write-up fully arrived (summary + extracted fields).
const completedCall = {
  id: 42,
  status: "completed",
  summary: "The caller wants a deep clean on Saturday.",
  serviceRequested: "Deep Clean",
  preferredTime: "Saturday morning",
};

// --- Setup / teardown ---------------------------------------------------------

beforeEach(() => {
  hooks.me.data = { canTakeLiveCalls: true };
  hooks.linkedCall.data = undefined;
  callDraftMock.mockReset();
  callDraftMock.mockResolvedValue(callDraft);
});

afterEach(() => {
  cleanup();
});

// --- Tests --------------------------------------------------------------------

describe("linked-call status row visibility", () => {
  it("shows the linked-call row inside the live panel for an entitled user with callId", () => {
    hooks.linkedCall.data = inProgressCall;
    const { getByTestId } = render(<NewBookingScreen />);
    // The live panel must exist and the fill button must be reachable.
    getByTestId("live-call-panel");
    getByTestId("fill-from-call-button");
  });

  it("hides everything from a user who cannot take live calls", () => {
    hooks.me.data = { canTakeLiveCalls: false };
    hooks.linkedCall.data = completedCall;
    const { queryByTestId } = render(<NewBookingScreen />);
    expect(queryByTestId("live-call-panel")).toBeNull();
    expect(queryByTestId("fill-from-call-button")).toBeNull();
  });
});

describe("manual fill button", () => {
  it("tapping 'Fill from call' calls getCallBookingDraft with the callId", async () => {
    hooks.linkedCall.data = completedCall;
    const { getByTestId } = render(<NewBookingScreen />);
    fireEvent.click(getByTestId("fill-from-call-button"));
    await waitFor(() => expect(callDraftMock).toHaveBeenCalledWith(42));
  });

  it("fills empty boxes with the draft values after a successful fetch", async () => {
    hooks.linkedCall.data = completedCall;
    const { getByTestId } = render(<NewBookingScreen />);
    fireEvent.click(getByTestId("fill-from-call-button"));
    await waitFor(() => {
      expect((getByTestId("input-name") as HTMLInputElement).value).toBe(
        "Janet Caller",
      );
      expect((getByTestId("input-phone") as HTMLInputElement).value).toBe(
        "780-555-4200",
      );
      expect((getByTestId("input-street") as HTMLInputElement).value).toBe(
        "42 Oak Ave",
      );
      expect((getByTestId("input-service") as HTMLInputElement).value).toBe(
        "Deep Clean",
      );
      expect((getByTestId("input-bedrooms") as HTMLInputElement).value).toBe(
        "3",
      );
    });
  });

  it("does not overwrite a box the owner already typed into", async () => {
    hooks.linkedCall.data = completedCall;
    const { getByTestId } = render(<NewBookingScreen />);
    // Owner types their own name before filling.
    fireEvent.change(getByTestId("input-name"), {
      target: { value: "Owner Typed This" },
    });
    fireEvent.click(getByTestId("fill-from-call-button"));
    await waitFor(() =>
      // The rest of the form must fill…
      expect((getByTestId("input-phone") as HTMLInputElement).value).toBe(
        "780-555-4200",
      ),
    );
    // …but the hand-typed name must survive.
    expect((getByTestId("input-name") as HTMLInputElement).value).toBe(
      "Owner Typed This",
    );
  });

  it("puts the caller's timing words into notes, never the date box", async () => {
    hooks.linkedCall.data = completedCall;
    const { getByTestId } = render(<NewBookingScreen />);
    fireEvent.click(getByTestId("fill-from-call-button"));
    await waitFor(() =>
      expect(
        (getByTestId("input-notes") as HTMLTextAreaElement).value,
      ).toContain("Asked for: next Saturday morning"),
    );
    // The date box must stay on today's default, not a parsed guess.
    const dateVal = (getByTestId("input-date") as HTMLInputElement).value;
    expect(dateVal).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(dateVal).not.toBe("");
    // It should not contain the literal preferred-time string.
    expect(dateVal).not.toContain("Saturday");
  });

  it("tapping 'Fill from call' twice adds the timing note exactly once", async () => {
    hooks.linkedCall.data = completedCall;
    const { getByTestId } = render(<NewBookingScreen />);

    // First tap — wait for the note to appear.
    fireEvent.click(getByTestId("fill-from-call-button"));
    await waitFor(() =>
      expect(
        (getByTestId("input-notes") as HTMLTextAreaElement).value,
      ).toContain("Asked for: next Saturday morning"),
    );

    // Capture the call count after the first fill has settled.
    const countAfterFirst = callDraftMock.mock.calls.length;

    // Second tap — the includes guard must block the duplicate.
    fireEvent.click(getByTestId("fill-from-call-button"));
    await waitFor(() =>
      expect(callDraftMock.mock.calls.length).toBeGreaterThan(countAfterFirst),
    );

    const notesValue = (getByTestId("input-notes") as HTMLTextAreaElement)
      .value;
    const occurrences = notesValue
      .split("\n")
      .filter((line) => line === "Asked for: next Saturday morning").length;
    expect(occurrences).toBe(1);
  });
});

describe("auto-fill on hangup", () => {
  it("auto-applies the draft the moment the linked call leaves in_progress", async () => {
    // Start with the call in progress — no draft yet.
    hooks.linkedCall.data = inProgressCall;
    const { rerender, getByTestId } = render(<NewBookingScreen />);
    expect(callDraftMock).not.toHaveBeenCalled();

    // Call hangs up: update the hook data and re-render.
    hooks.linkedCall.data = completedCall;
    rerender(<NewBookingScreen />);

    await waitFor(() => expect(callDraftMock).toHaveBeenCalledWith(42));
    await waitFor(() =>
      expect((getByTestId("input-name") as HTMLInputElement).value).toBe(
        "Janet Caller",
      ),
    );
  });

  it("auto-applies the write-up when Quo delivers it on a later poll after hangup", async () => {
    // Quo fires transcript + summary as separate post-call webhooks. The first
    // completed response is often still empty; a subsequent poll delivers the
    // write-up. The screen must re-scan when the stamp changes, not treat the
    // early empty response as conclusive.

    // First poll: call ended but write-up hasn't arrived yet.
    callDraftMock.mockResolvedValueOnce(emptyDraft);
    hooks.linkedCall.data = completedNoWriteup;
    const { rerender, getByTestId } = render(<NewBookingScreen />);

    // The empty-completed stamp is different from the initial "" — a scan
    // fires, but the empty draft fills nothing.
    await waitFor(() => expect(callDraftMock).toHaveBeenCalledTimes(1));
    expect((getByTestId("input-name") as HTMLInputElement).value).toBe("");

    // Next poll: write-up fully arrived — stamp changes, second scan fires.
    hooks.linkedCall.data = completedCall;
    rerender(<NewBookingScreen />);

    await waitFor(() => expect(callDraftMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect((getByTestId("input-name") as HTMLInputElement).value).toBe(
        "Janet Caller",
      ),
    );
  });

  it("does not re-apply the same draft if the call data refetches with identical content", async () => {
    hooks.linkedCall.data = completedCall;
    const { rerender } = render(<NewBookingScreen />);
    await waitFor(() => expect(callDraftMock).toHaveBeenCalledTimes(1));

    // Refetch returns the same call — stamp is unchanged, no second fetch.
    rerender(<NewBookingScreen />);
    await waitFor(() => expect(callDraftMock).toHaveBeenCalledTimes(1));
  });
});
