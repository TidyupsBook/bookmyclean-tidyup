// @vitest-environment jsdom
/**
 * The live-call panel on the mobile New Booking screen: the owner listens to
 * a call on speaker and the boxes fill themselves from the same server-side
 * extraction the web dashboard uses.
 *
 * Under test:
 *  - the panel is positively gated on canTakeLiveCalls (nothing while `me`
 *    loads, nothing for a plain cleaner);
 *  - a transcript pause sends the words to POST /booking-drafts and the
 *    draft fills only boxes the owner hasn't typed in;
 *  - the "filled from the call" note counts what landed;
 *  - the unsupported (Expo Go) state is named, not a dead button;
 *  - losing the entitlement mid-session ends the capture, drops in-flight
 *    scans and forgets the filled-from-call markers.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  fireEvent,
  cleanup,
  act,
  waitFor,
} from "@testing-library/react";

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

// Most tests run with no callId; the earbuds-note tests set one to prove the
// after-hangup promise only appears for a screen linked to a real call.
const routeParams = vi.hoisted(() => ({
  current: {} as Record<string, string>,
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useLocalSearchParams: () => routeParams.current,
  useNavigation: () => ({ addListener: vi.fn(() => vi.fn()) }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  // useMutation is used directly by the scanCall (getCallBookingDraft) logic.
  // No callId in these tests so the mutate is never called, but the hook
  // must exist so the component can render.
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

const draftMutate = vi.fn();
const createBookingMutate = vi.fn();

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
    data: [{ name: "Deep Clean" }],
    isLoading: false,
    isError: false,
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  // Keep the hand-written pure helpers real.
  ...(await importOriginal<Record<string, unknown>>()),
  useGetCompany: () => hooks.company,
  useListServices: () => hooks.services,
  useGetLead: () => ({ data: undefined, isLoading: false, isError: false }),
  useGetCurrentUser: () => hooks.me,
  useCreateBooking: () => ({ mutate: createBookingMutate, isPending: false }),
  useConvertLead: () => ({ mutate: vi.fn(), isPending: false }),
  useDraftBookingFromText: () => ({ mutate: draftMutate, isPending: false }),
  // callId-linked call — no callId in these tests so this is never queried.
  useGetCall: () => ({ data: undefined, isLoading: false }),
  getCallBookingDraft: vi.fn(),
  getGetCallQueryKey: (id: number) => ["/calls", id],
  getListLeadsQueryKey: () => ["/leads"],
  getListBookingsQueryKey: () => ["/bookings"],
  getGetDashboardSummaryQueryKey: () => ["/dashboard/summary"],
}));

// The capture session itself is proven in lib/live-capture.test.tsx; here it
// is a hand-cranked fixture so the screen's wiring is what's under test.
const capture = vi.hoisted(() => ({
  current: {
    supported: true,
    status: "idle" as string,
    listening: false,
    starting: false,
    reconnecting: false,
    active: false,
    text: "",
    interim: "",
    error: null as string | null,
    stopReason: null as string | null,
    failed: false,
    diagnostics: {
      platform: "web" as const,
      permission: "not-requested" as const,
      recognizerError: null as string | null,
      lastTranscriptStage: "not-started" as const,
    },
    start: vi.fn(),
    stop: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock("@/lib/live-capture", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useLiveCapture: () => capture.current,
}));

import NewBookingScreen from "@/app/booking/new";

beforeEach(() => {
  vi.useFakeTimers();
  routeParams.current = {};
  hooks.me.data = { canTakeLiveCalls: true };
  capture.current = {
    ...capture.current,
    supported: true,
    status: "idle",
    listening: false,
    reconnecting: false,
    active: false,
    text: "",
    interim: "",
    error: null,
    stopReason: null,
    start: vi.fn(),
    stop: vi.fn(),
    clear: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  draftMutate.mockReset();
  createBookingMutate.mockReset();
});

const draft = {
  callId: null,
  customerName: "Jane Doe",
  customerPhone: "780-555-0100",
  customerAddress: "123 Main St",
  addressCity: "St. Albert",
  addressProvince: "AB",
  addressPostal: "T8N 1N3",
  service: "Deep Clean",
  bedrooms: 3,
  bathrooms: 2,
  preferredTime: "next Tuesday morning",
  internalNotes: null,
  filledFields: ["customerName"],
};

describe("live-call panel gating", () => {
  it("shows nothing while me is still loading, and nothing without the entitlement", () => {
    hooks.me.data = undefined;
    const first = render(<NewBookingScreen />);
    expect(first.queryByTestId("live-call-panel")).toBeNull();
    first.unmount();

    hooks.me.data = { canTakeLiveCalls: false };
    const second = render(<NewBookingScreen />);
    expect(second.queryByTestId("live-call-panel")).toBeNull();
  });

  it("shows the panel with a Listen control for someone entitled", () => {
    const view = render(<NewBookingScreen />);
    const { getByTestId } = view;
    getByTestId("live-call-panel");
    fireEvent.click(getByTestId("live-toggle-button"));
    expect(capture.current.start).toHaveBeenCalledTimes(1);
  });

  it("names the missing recognizer instead of showing a dead button", () => {
    capture.current.supported = false;
    const { getByTestId, queryByTestId } = render(<NewBookingScreen />);
    getByTestId("live-unsupported");
    expect(queryByTestId("live-toggle-button")).toBeNull();
  });

  it("offers Stop while a session is running", () => {
    capture.current.active = true;
    capture.current.listening = true;
    capture.current.status = "listening";
    const { getByTestId } = render(<NewBookingScreen />);
    fireEvent.click(getByTestId("live-toggle-button"));
    expect(capture.current.stop).toHaveBeenCalledTimes(1);
  });
});

/**
 * The earbuds note must stay honest in both directions. The after-hangup
 * auto-fill only runs when this screen is linked to a Quo call — that is
 * what gets polled — so the unlinked screen has to say how to get there,
 * never promise a fill that will not come.
 */
describe("earbuds honesty note", () => {
  it("without a linked call, points at opening the form from the call", () => {
    const { getByTestId } = render(<NewBookingScreen />);
    const note = getByTestId("live-earbuds-note").textContent ?? "";
    expect(note).toMatch(/can't listen to its own call/i);
    expect(note).toMatch(/open new booking from the call/i);
    expect(note).not.toMatch(/finish the call and the write-up/i);
  });

  it("with a linked call, promises the after-hangup fill", () => {
    routeParams.current = { callId: "7" };
    const { getByTestId } = render(<NewBookingScreen />);
    const note = getByTestId("live-earbuds-note").textContent ?? "";
    expect(note).toMatch(/can't listen to its own call/i);
    expect(note).toMatch(/finish the call and the write-up/i);
  });
});

describe("transcript-driven fill", () => {
  it("sends the complete multi-entry native transcript for extraction without saving", () => {
    capture.current.listening = true;
    capture.current.active = true;
    capture.current.status = "listening";
    // This is the joined value produced when a native recognizer returns
    // multiple ordered result entries instead of one transcript string.
    capture.current.text =
      "hi this is Jane Doe my number is 780-555-0100 at 123 Main Street";

    const view = render(<NewBookingScreen />);
    expect(view.getByTestId("live-transcript").textContent).toContain(
      "780-555-0100",
    );

    act(() => {
      vi.advanceTimersByTime(1300);
    });

    expect(draftMutate).toHaveBeenCalledTimes(1);
    expect(view.getByTestId("live-diagnostics").textContent).toContain(
      "Last stage: extraction-requested",
    );
    expect(draftMutate.mock.calls[0]![0]).toEqual({
      data: {
        text: "hi this is Jane Doe my number is 780-555-0100 at 123 Main Street",
      },
    });
    expect(createBookingMutate).not.toHaveBeenCalled();
  });

  it("fills the form from an Android-style segmented transcript without saving or contacting the customer", () => {
    // Android can settle several independent final segments while the same
    // recognizer run remains open. The capture layer joins those segments;
    // the booking screen should treat the joined words exactly like any
    // other transcript.
    capture.current.listening = true;
    capture.current.active = true;
    capture.current.status = "listening";
    capture.current.text = "hi this is Jane Doe my number is 780-555-0100";

    const view = render(<NewBookingScreen />);
    expect(view.getByTestId("live-transcript").textContent).toContain(
      "Jane Doe",
    );
    act(() => {
      vi.advanceTimersByTime(1300);
    });

    expect(draftMutate).toHaveBeenCalledTimes(1);
    expect(draftMutate.mock.calls[0]![0]).toEqual({
      data: { text: "hi this is Jane Doe my number is 780-555-0100" },
    });

    const { onSuccess } = draftMutate.mock.calls[0]![1] as {
      onSuccess: (d: unknown) => void;
    };
    act(() =>
      onSuccess({
        ...draft,
        filledFields: ["customerName", "customerPhone"],
      }),
    );

    expect((view.getByTestId("input-name") as HTMLInputElement).value).toBe(
      "Jane Doe",
    );
    expect((view.getByTestId("input-phone") as HTMLInputElement).value).toBe(
      "780-555-0100",
    );
    expect(createBookingMutate).not.toHaveBeenCalled();
  });

  it("a pause sends the words to the extraction endpoint and the draft fills empty boxes", async () => {
    capture.current.listening = true;
    capture.current.active = true;
    capture.current.status = "listening";
    capture.current.text =
      "hi this is Jane Doe calling about a deep clean at 123 Main St";

    const view = render(<NewBookingScreen />);
    const { getByTestId } = view;
    // The debounce waits for the pause between sentences.
    expect(draftMutate).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1300);
    });
    expect(draftMutate).toHaveBeenCalledTimes(1);
    expect(draftMutate.mock.calls[0]![0]).toEqual({
      data: { text: capture.current.text },
    });

    // The server answers; the boxes fill and the note counts them.
    const { onSuccess } = draftMutate.mock.calls[0]![1] as {
      onSuccess: (d: unknown) => void;
    };
    act(() => onSuccess(draft));

    const diagnostics = view.getByTestId("live-diagnostics").textContent ?? "";
    expect(diagnostics).toContain("Last stage: extraction-succeeded");
    expect(diagnostics).not.toContain(capture.current.text);
    expect((getByTestId("input-name") as HTMLInputElement).value).toBe(
      "Jane Doe",
    );
    expect((getByTestId("input-phone") as HTMLInputElement).value).toBe(
      "780-555-0100",
    );
    expect((getByTestId("input-street") as HTMLInputElement).value).toBe(
      "123 Main St",
    );
    expect((getByTestId("input-city") as HTMLInputElement).value).toBe(
      "St. Albert",
    );
    expect((getByTestId("input-bedrooms") as HTMLInputElement).value).toBe("3");
    // The caller's words about timing go into the notes verbatim, never the
    // date box.
    expect((getByTestId("input-notes") as HTMLInputElement).value).toContain(
      "Asked for: next Tuesday morning",
    );
    expect((getByTestId("input-date") as HTMLInputElement).value).not.toContain(
      "Tuesday",
    );
    getByTestId("live-filled-note");
  });

  it("shows an extraction failure and retries the latest transcript without applying the old response", () => {
    capture.current.listening = true;
    capture.current.active = true;
    capture.current.status = "listening";
    capture.current.text =
      "hi this is Jane Doe calling about a deep clean at 123 Main St";

    const view = render(<NewBookingScreen />);
    act(() => {
      vi.advanceTimersByTime(1300);
    });
    expect(draftMutate).toHaveBeenCalledTimes(1);

    const firstOptions = draftMutate.mock.calls[0]![1] as {
      onSuccess: (d: unknown) => void;
      onError: (error: unknown) => void;
    };
    act(() => firstOptions.onError(new Error("temporary extraction failure")));

    expect(view.getByTestId("live-transcript-error").textContent).toMatch(
      /couldn't fill the booking form/i,
    );
    expect(view.getByTestId("retry-transcript-button").textContent).toMatch(
      /retry form fill/i,
    );

    fireEvent.click(view.getByTestId("retry-transcript-button"));
    expect(draftMutate).toHaveBeenCalledTimes(2);
    expect(draftMutate.mock.calls[1]![0]).toEqual({
      data: { text: capture.current.text },
    });

    // The failed request may still settle after the retry. It no longer owns
    // this transcript and must not fill the form.
    act(() => firstOptions.onSuccess(draft));
    expect((view.getByTestId("input-name") as HTMLInputElement).value).toBe("");

    const retryOptions = draftMutate.mock.calls[1]![1] as {
      onSuccess: (d: unknown) => void;
    };
    act(() => retryOptions.onSuccess(draft));
    expect((view.getByTestId("input-name") as HTMLInputElement).value).toBe(
      "Jane Doe",
    );
    expect(view.queryByTestId("live-transcript-error")).toBeNull();
  });

  it("never overwrites a box the owner already typed in", async () => {
    capture.current.listening = true;
    capture.current.active = true;
    capture.current.status = "listening";
    capture.current.text = "hi this is Jane Doe calling about a clean";

    const { getByTestId } = render(<NewBookingScreen />);
    fireEvent.change(getByTestId("input-name"), {
      target: { value: "Someone Else" },
    });
    fireEvent.change(getByTestId("input-city"), {
      target: { value: "Leduc" },
    });
    act(() => {
      vi.advanceTimersByTime(1300);
    });
    const { onSuccess } = draftMutate.mock.calls[0]![1] as {
      onSuccess: (d: unknown) => void;
    };
    act(() => onSuccess(draft));
    expect((getByTestId("input-name") as HTMLInputElement).value).toBe(
      "Someone Else",
    );
    expect((getByTestId("input-city") as HTMLInputElement).value).toBe("Leduc");
    // Untyped boxes still fill.
    expect((getByTestId("input-phone") as HTMLInputElement).value).toBe(
      "780-555-0100",
    );
  });

  it("a short fragment is not worth a server round trip", () => {
    capture.current.listening = true;
    capture.current.active = true;
    capture.current.text = "hi";
    render(<NewBookingScreen />);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(draftMutate).not.toHaveBeenCalled();
  });

  it("after a clear and restart the second transcript fills the remaining empty boxes without touching the already-filled ones", async () => {
    // Phase 1: first burst of speech — name and phone arrive.
    capture.current.listening = true;
    capture.current.active = true;
    capture.current.status = "listening";
    capture.current.text = "hi this is Jane Doe my number is 780-555-0100";

    const view = render(<NewBookingScreen />);

    act(() => {
      vi.advanceTimersByTime(1300);
    });
    expect(draftMutate).toHaveBeenCalledTimes(1);

    const phase1Draft = {
      callId: null,
      customerName: "Jane Doe",
      customerPhone: "780-555-0100",
      customerAddress: null,
      addressCity: null,
      addressProvince: null,
      addressPostal: null,
      service: null,
      bedrooms: null,
      bathrooms: null,
      preferredTime: null,
      internalNotes: null,
      filledFields: ["customerName", "customerPhone"],
    };
    const { onSuccess: onSuccess1 } = draftMutate.mock.calls[0]![1] as {
      onSuccess: (d: unknown) => void;
    };
    act(() => onSuccess1(phase1Draft));

    expect((view.getByTestId("input-name") as HTMLInputElement).value).toBe(
      "Jane Doe",
    );
    expect((view.getByTestId("input-phone") as HTMLInputElement).value).toBe(
      "780-555-0100",
    );
    expect((view.getByTestId("input-street") as HTMLInputElement).value).toBe(
      "",
    );

    // The owner taps the Clear button: capture.clear() is called explicitly,
    // then listening goes false while the recognizer stops and the transcript
    // is wiped. Model the real lifecycle, not just a text assignment.
    act(() => {
      capture.current.clear();
    });
    capture.current.listening = false;
    capture.current.active = false;
    capture.current.status = "idle";
    capture.current.text = "";
    view.rerender(<NewBookingScreen />);

    // While stopped the scan timer must not fire on the empty transcript.
    act(() => {
      vi.advanceTimersByTime(1300);
    });
    expect(draftMutate).toHaveBeenCalledTimes(1); // still just the phase-1 call

    // The microphone restarts — listening transitions back to true with fresh
    // speech about the address.
    capture.current.listening = true;
    capture.current.active = true;
    capture.current.status = "listening";
    capture.current.text =
      "the address is 123 Main St in St Albert Alberta T8N 1N3";
    view.rerender(<NewBookingScreen />);

    act(() => {
      vi.advanceTimersByTime(1300);
    });
    expect(draftMutate).toHaveBeenCalledTimes(2);

    const phase2Draft = {
      callId: null,
      customerName: null,
      customerPhone: null,
      customerAddress: "123 Main St",
      addressCity: "St. Albert",
      addressProvince: "AB",
      addressPostal: "T8N 1N3",
      service: "Deep Clean",
      bedrooms: 3,
      bathrooms: 2,
      preferredTime: null,
      internalNotes: null,
      filledFields: [
        "customerAddress",
        "addressCity",
        "addressProvince",
        "addressPostal",
        "service",
        "bedrooms",
        "bathrooms",
      ],
    };
    const { onSuccess: onSuccess2 } = draftMutate.mock.calls[1]![1] as {
      onSuccess: (d: unknown) => void;
    };
    act(() => onSuccess2(phase2Draft));

    // Phase-1 values are intact.
    expect((view.getByTestId("input-name") as HTMLInputElement).value).toBe(
      "Jane Doe",
    );
    expect((view.getByTestId("input-phone") as HTMLInputElement).value).toBe(
      "780-555-0100",
    );
    // Phase-2 values landed in the still-empty boxes.
    expect((view.getByTestId("input-street") as HTMLInputElement).value).toBe(
      "123 Main St",
    );
    expect((view.getByTestId("input-city") as HTMLInputElement).value).toBe(
      "St. Albert",
    );
    expect((view.getByTestId("input-bedrooms") as HTMLInputElement).value).toBe(
      "3",
    );
    expect(
      (view.getByTestId("input-bathrooms") as HTMLInputElement).value,
    ).toBe("2");
  });

  it("ignores a phase-1 answer that arrives after the transcript was cleared, then applies phase-2 values", () => {
    capture.current.listening = true;
    capture.current.active = true;
    capture.current.status = "listening";
    capture.current.text = "hi this is Jane Doe my number is 780-555-0100";

    const view = render(<NewBookingScreen />);

    act(() => {
      vi.advanceTimersByTime(1300);
    });
    expect(draftMutate).toHaveBeenCalledTimes(1);

    const { onSuccess: onSuccess1 } = draftMutate.mock.calls[0]![1] as {
      onSuccess: (d: unknown) => void;
    };

    // The first request is now in flight. Clearing the transcript starts a
    // new scan era, so its eventual answer must not be allowed to land.
    act(() => {
      capture.current.clear();
    });
    capture.current.listening = false;
    capture.current.active = false;
    capture.current.status = "idle";
    capture.current.text = "";
    view.rerender(<NewBookingScreen />);

    capture.current.listening = true;
    capture.current.active = true;
    capture.current.status = "listening";
    capture.current.text =
      "the address is 123 Main St in St Albert Alberta T8N 1N3";
    view.rerender(<NewBookingScreen />);

    act(() => {
      vi.advanceTimersByTime(1300);
    });
    expect(draftMutate).toHaveBeenCalledTimes(2);

    // Phase 1 answers after phase 2 has started. If the era guard regresses,
    // these values would occupy the empty boxes before phase 2 arrives.
    act(() =>
      onSuccess1({
        callId: null,
        customerName: "Stale Phase One",
        customerPhone: "780-555-0199",
        customerAddress: "999 Wrong St",
        addressCity: "Wrong City",
        addressProvince: "ZZ",
        addressPostal: "Z9Z 9Z9",
        service: "Wrong Service",
        bedrooms: 9,
        bathrooms: 9,
        preferredTime: "wrong time",
        internalNotes: "wrong notes",
        filledFields: [
          "customerName",
          "customerPhone",
          "customerAddress",
          "addressCity",
          "addressProvince",
          "addressPostal",
          "service",
          "bedrooms",
          "bathrooms",
        ],
      }),
    );

    expect((view.getByTestId("input-name") as HTMLInputElement).value).toBe("");
    expect((view.getByTestId("input-phone") as HTMLInputElement).value).toBe(
      "",
    );
    expect((view.getByTestId("input-street") as HTMLInputElement).value).toBe(
      "",
    );
    expect((view.getByTestId("input-notes") as HTMLInputElement).value).toBe(
      "",
    );

    const { onSuccess: onSuccess2 } = draftMutate.mock.calls[1]![1] as {
      onSuccess: (d: unknown) => void;
    };
    act(() =>
      onSuccess2({
        callId: null,
        customerName: null,
        customerPhone: null,
        customerAddress: "123 Main St",
        addressCity: "St. Albert",
        addressProvince: "AB",
        addressPostal: "T8N 1N3",
        service: "Deep Clean",
        bedrooms: 3,
        bathrooms: 2,
        preferredTime: null,
        internalNotes: null,
        filledFields: [
          "customerAddress",
          "addressCity",
          "addressProvince",
          "addressPostal",
          "service",
          "bedrooms",
          "bathrooms",
        ],
      }),
    );

    // Phase 1 stayed out; phase 2 filled the boxes that were still empty.
    expect((view.getByTestId("input-name") as HTMLInputElement).value).toBe("");
    expect((view.getByTestId("input-phone") as HTMLInputElement).value).toBe(
      "",
    );
    expect((view.getByTestId("input-street") as HTMLInputElement).value).toBe(
      "123 Main St",
    );
    expect((view.getByTestId("input-city") as HTMLInputElement).value).toBe(
      "St. Albert",
    );
    expect((view.getByTestId("input-province") as HTMLInputElement).value).toBe(
      "AB",
    );
    expect((view.getByTestId("input-postal") as HTMLInputElement).value).toBe(
      "T8N 1N3",
    );
    expect((view.getByTestId("input-service") as HTMLInputElement).value).toBe(
      "Deep Clean",
    );
    expect((view.getByTestId("input-bedrooms") as HTMLInputElement).value).toBe(
      "3",
    );
    expect(
      (view.getByTestId("input-bathrooms") as HTMLInputElement).value,
    ).toBe("2");
  });
});

describe("losing the entitlement mid-session", () => {
  it("ends the capture, drops the in-flight scan and forgets the filled markers", async () => {
    capture.current.listening = true;
    capture.current.active = true;
    capture.current.status = "listening";
    capture.current.text =
      "hi this is Jane Doe calling about a deep clean at 123 Main St";

    const view = render(<NewBookingScreen />);
    act(() => {
      vi.advanceTimersByTime(1300);
    });
    const { onSuccess } = draftMutate.mock.calls[0]![1] as {
      onSuccess: (d: unknown) => void;
    };

    // Access is revoked while the scan is still in flight.
    hooks.me.data = { canTakeLiveCalls: false };
    view.rerender(<NewBookingScreen />);

    expect(capture.current.stop).toHaveBeenCalled();
    expect(capture.current.clear).toHaveBeenCalled();
    expect(view.queryByTestId("live-call-panel")).toBeNull();

    // The late answer must not fill boxes from a call this person can no
    // longer take.
    act(() => onSuccess(draft));
    expect((view.getByTestId("input-name") as HTMLInputElement).value).toBe("");
    expect(view.queryByTestId("live-filled-note")).toBeNull();
  });

  it("fails closed when the current-user answer disappears after access existed", () => {
    capture.current.listening = true;
    capture.current.active = true;
    capture.current.status = "listening";
    capture.current.text =
      "hi this is Jane Doe calling about a deep clean at 123 Main St";

    const view = render(<NewBookingScreen />);
    act(() => {
      vi.advanceTimersByTime(1300);
    });
    const { onSuccess } = draftMutate.mock.calls[0]![1] as {
      onSuccess: (d: unknown) => void;
    };
    act(() => onSuccess(draft));
    expect((view.getByTestId("input-name") as HTMLInputElement).value).toBe(
      "Jane Doe",
    );

    // The /me answer vanishes (sign-out, failed refresh, reset session) —
    // not an explicit "no", but the mic must not stay hot on an unknown.
    hooks.me.data = undefined;
    view.rerender(<NewBookingScreen />);

    expect(capture.current.stop).toHaveBeenCalled();
    expect(capture.current.clear).toHaveBeenCalled();
    expect(view.queryByTestId("live-call-panel")).toBeNull();
    // Call-derived values are gone too.
    expect((view.getByTestId("input-name") as HTMLInputElement).value).toBe("");
    expect((view.getByTestId("input-phone") as HTMLInputElement).value).toBe(
      "",
    );
  });

  it("strips the call-added note line even after the owner edits Notes, keeping the owner's own text", () => {
    capture.current.listening = true;
    capture.current.active = true;
    capture.current.status = "listening";
    capture.current.text =
      "hi this is Jane Doe calling about a deep clean at 123 Main St";

    const view = render(<NewBookingScreen />);
    act(() => {
      vi.advanceTimersByTime(1300);
    });
    const { onSuccess } = draftMutate.mock.calls[0]![1] as {
      onSuccess: (d: unknown) => void;
    };
    act(() => onSuccess(draft));

    const notesBox = view.getByTestId("input-notes") as HTMLInputElement;
    expect(notesBox.value).toContain("Asked for: next Tuesday morning");

    // The owner appends their own note under the call-added line. This edit
    // must not launder the call line into owner-typed text.
    fireEvent.change(notesBox, {
      target: {
        value: `${notesBox.value}\nGate code is 4321`,
      },
    });

    // Access is revoked.
    hooks.me.data = { canTakeLiveCalls: false };
    view.rerender(<NewBookingScreen />);

    // The call's line is gone, the owner's own line remains.
    expect(notesBox.value).not.toContain("Asked for:");
    expect(notesBox.value).toContain("Gate code is 4321");
  });

  it("clears every box still holding the caller's words, but keeps what the owner typed over", () => {
    capture.current.listening = true;
    capture.current.active = true;
    capture.current.status = "listening";
    capture.current.text =
      "hi this is Jane Doe calling about a deep clean at 123 Main St";

    const view = render(<NewBookingScreen />);
    act(() => {
      vi.advanceTimersByTime(1300);
    });
    const { onSuccess } = draftMutate.mock.calls[0]![1] as {
      onSuccess: (d: unknown) => void;
    };
    // The draft lands while access is still good.
    act(() => onSuccess(draft));
    expect((view.getByTestId("input-name") as HTMLInputElement).value).toBe(
      "Jane Doe",
    );

    // The owner corrects the name themselves — that box is theirs now.
    fireEvent.change(view.getByTestId("input-name"), {
      target: { value: "Janet Doherty" },
    });
    const notesBox = view.getByTestId("input-notes") as HTMLInputElement;
    expect(notesBox.value).toContain("Asked for: next Tuesday morning");

    // Access is revoked.
    hooks.me.data = { canTakeLiveCalls: false };
    view.rerender(<NewBookingScreen />);

    // Call-derived values are gone…
    expect((view.getByTestId("input-phone") as HTMLInputElement).value).toBe(
      "",
    );
    expect((view.getByTestId("input-street") as HTMLInputElement).value).toBe(
      "",
    );
    expect((view.getByTestId("input-postal") as HTMLInputElement).value).toBe(
      "",
    );
    expect((view.getByTestId("input-service") as HTMLInputElement).value).toBe(
      "",
    );
    expect((view.getByTestId("input-bedrooms") as HTMLInputElement).value).toBe(
      "",
    );
    expect(
      (view.getByTestId("input-bathrooms") as HTMLInputElement).value,
    ).toBe("");
    // …the city/province defaults come back…
    expect((view.getByTestId("input-city") as HTMLInputElement).value).toBe(
      "Edmonton",
    );
    expect((view.getByTestId("input-province") as HTMLInputElement).value).toBe(
      "AB",
    );
    // …the call-added note line is stripped…
    expect(notesBox.value).not.toContain("Asked for:");
    // …but the value the owner typed themselves survives.
    expect((view.getByTestId("input-name") as HTMLInputElement).value).toBe(
      "Janet Doherty",
    );
  });
});
