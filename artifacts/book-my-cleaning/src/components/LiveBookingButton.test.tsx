// @vitest-environment jsdom
/**
 * The always-there Live booking launcher. These tests pin the promises the
 * task makes: it exists for an entitled owner on every page (and for nobody
 * else, and never on the booking desk), it blinks for a ringing call and for
 * a finished-but-unbooked one, tapping carries the right call to the desk,
 * the waiting flag survives a remount, it reads the same store the Calls
 * page markers use, and nothing blinks under reduced motion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

type FakeCall = {
  id: number;
  callerName: string;
  callerPhone: string;
  status: string;
  startedAt: string;
  durationSeconds: number;
  isTest: boolean;
  direction: string | null;
};

let callsData: FakeCall[] = [];
let lastQueryOptions: Record<string, unknown> | null = null;
let me: {
  canTakeLiveCalls: boolean;
  email: string;
  companyName: string;
} | null = null;

vi.mock("@workspace/api-client-react", () => ({
  useListCalls: (
    _params: unknown,
    options: { query: Record<string, unknown> },
  ) => {
    lastQueryOptions = options.query;
    return { data: callsData };
  },
  getListCallsQueryKey: () => ["/api/calls"],
  useGetCurrentUser: () => ({ data: me }),
}));

let location = "/";
const navigate = vi.fn();
vi.mock("wouter", () => ({
  useLocation: () => [location, navigate],
}));

// The capture session, as the corner logic sees it. Null = outside the
// provider (also the common idle case on devices that cannot listen).
let captureState: unknown = null;
vi.mock("@/lib/callCapture", () => ({
  useCallCapture: () => captureState,
}));

import { LiveBookingButton } from "./LiveBookingButton";
import { markCallSeen } from "@/lib/callAttention";

let reduceMotion = false;

function call(over: Partial<FakeCall> & { id: number }): FakeCall {
  return {
    callerName: "Dana Miller",
    callerPhone: "+15550001111",
    status: "completed",
    startedAt: "2026-08-14T12:00:00Z",
    durationSeconds: 60,
    isTest: false,
    direction: "inbound",
    ...over,
  };
}

let identityCounter = 0;
let identity = "";

/** Prime the shared attention store so finished calls read as waiting. */
function primeEmpty() {
  localStorage.setItem(`bmc.callAttention.v1.${identity}`, "[]");
}

beforeEach(() => {
  localStorage.clear();
  callsData = [];
  lastQueryOptions = null;
  location = "/";
  captureState = null;
  reduceMotion = false;
  const email = `owner-${++identityCounter}@example.com`;
  me = { canTakeLiveCalls: true, email, companyName: "Sparkle" };
  identity = `${email}@Sparkle`;
  navigate.mockReset();
  window.matchMedia = ((query: string) => ({
    matches: reduceMotion && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
});

describe("who sees it, and where", () => {
  it("shows a calm launcher to an entitled owner with nothing going on", () => {
    render(<LiveBookingButton />);
    const button = screen.getByTestId("button-live-booking");
    expect(button).toHaveAttribute("data-state", "idle");
    expect(button).toHaveTextContent("Live booking");
    expect(button.className).not.toContain("animate-pulse");
  });

  it("shows nothing to a cleaner", () => {
    me = { ...me!, canTakeLiveCalls: false };
    render(<LiveBookingButton />);
    expect(screen.queryByTestId("button-live-booking")).toBeNull();
  });

  it("disappears the moment live-call access is revoked mid-session", () => {
    const { rerender } = render(<LiveBookingButton />);
    expect(screen.getByTestId("button-live-booking")).toBeInTheDocument();
    me = { ...me!, canTakeLiveCalls: false };
    rerender(<LiveBookingButton />);
    expect(screen.queryByTestId("button-live-booking")).toBeNull();
  });

  it("stays off the booking desk itself", () => {
    location = "/bookings/new?callId=4";
    render(<LiveBookingButton />);
    expect(screen.queryByTestId("button-live-booking")).toBeNull();
  });

  it("yields the corner while the live-call bar has real work", () => {
    captureState = {
      transcript: { active: true },
      needsPermission: false,
      declined: null,
    };
    render(<LiveBookingButton />);
    expect(screen.queryByTestId("button-live-booking")).toBeNull();
  });

  it("keeps the corner when the only decline is 'unsupported' — the iPad case", () => {
    captureState = {
      transcript: { active: false },
      needsPermission: false,
      declined: "unsupported",
    };
    render(<LiveBookingButton />);
    expect(screen.getByTestId("button-live-booking")).toBeInTheDocument();
  });

  it("never asks for its own polling interval — the app-wide watcher owns that", () => {
    render(<LiveBookingButton />);
    expect(lastQueryOptions).not.toBeNull();
    expect(lastQueryOptions).not.toHaveProperty("refetchInterval");
  });
});

describe("blink states and taps", () => {
  it("opens a fresh blank booking when nothing needs attention", () => {
    render(<LiveBookingButton />);
    fireEvent.click(screen.getByTestId("button-live-booking"));
    expect(navigate).toHaveBeenCalledWith("/bookings/new");
  });

  it("blinks and names the caller while a call is ringing, and tapping takes that call", () => {
    callsData = [call({ id: 9, status: "in_progress" })];
    render(<LiveBookingButton />);
    const button = screen.getByTestId("button-live-booking");
    expect(button).toHaveAttribute("data-state", "ringing");
    expect(button).toHaveTextContent(
      "Dana Miller is currently connected to the receptionist",
    );
    expect(button.className).toContain("animate-pulse");
    fireEvent.click(button);
    expect(navigate).toHaveBeenCalledWith("/bookings/new?callId=9");
  });

  it("dismisses only the active call and keeps it quiet after it ends", () => {
    callsData = [call({ id: 10, status: "in_progress" })];
    const { rerender } = render(<LiveBookingButton />);

    expect(screen.getByTestId("button-live-booking")).toHaveAttribute(
      "data-state",
      "ringing",
    );
    fireEvent.click(screen.getByTestId("button-live-booking-dismiss-ringing"));

    expect(screen.getByTestId("button-live-booking")).toHaveAttribute(
      "data-state",
      "idle",
    );
    expect(
      JSON.parse(localStorage.getItem(`bmc.callAttention.v1.${identity}`)!),
    ).toContain(10);

    callsData = [call({ id: 10, status: "completed" })];
    rerender(<LiveBookingButton />);
    expect(screen.getByTestId("button-live-booking")).toHaveAttribute(
      "data-state",
      "idle",
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not hide another active customer's alert when one is dismissed", () => {
    callsData = [
      call({ id: 11, status: "in_progress", callerName: "First caller" }),
      call({ id: 12, status: "in_progress", callerName: "Second caller" }),
    ];
    render(<LiveBookingButton />);

    fireEvent.click(screen.getByTestId("button-live-booking-dismiss-ringing"));

    expect(screen.getByTestId("button-live-booking")).toHaveAttribute(
      "data-state",
      "ringing",
    );
    expect(screen.getByTestId("button-live-booking")).toHaveTextContent(
      "Second caller is currently connected to the receptionist",
    );
    expect(
      screen.getByTestId("button-live-booking-dismiss-ringing"),
    ).toBeInTheDocument();
  });

  it("stays calm for a ringing test call, exactly like the red banner", () => {
    callsData = [call({ id: 9, status: "in_progress", isTest: true })];
    render(<LiveBookingButton />);
    expect(screen.getByTestId("button-live-booking")).toHaveAttribute(
      "data-state",
      "idle",
    );
  });

  it("blinks for a finished call still waiting, and tapping opens the desk for it", () => {
    primeEmpty();
    callsData = [call({ id: 12 })];
    render(<LiveBookingButton />);
    const button = screen.getByTestId("button-live-booking");
    expect(button).toHaveAttribute("data-state", "waiting");
    expect(button).toHaveTextContent("Book Dana Miller");
    expect(button.className).toContain("animate-pulse");
    fireEvent.click(button);
    expect(navigate).toHaveBeenCalledWith("/bookings/new?callId=12");
  });

  it("leads with the newest waiting call and counts the rest", () => {
    primeEmpty();
    callsData = [
      call({ id: 22, callerName: "Newest Caller" }),
      call({ id: 21, callerName: "Older Caller" }),
    ];
    render(<LiveBookingButton />);
    const button = screen.getByTestId("button-live-booking");
    expect(button).toHaveTextContent("Book Newest Caller");
    expect(screen.getByTestId("text-live-booking-more")).toHaveTextContent(
      "+1",
    );
    fireEvent.click(button);
    expect(navigate).toHaveBeenCalledWith("/bookings/new?callId=22");
  });

  it("clears every waiting call at once and returns to idle", () => {
    primeEmpty();
    callsData = [
      call({ id: 22, callerName: "Newest Caller" }),
      call({ id: 21, callerName: "Older Caller" }),
      call({ id: 20, callerName: "Oldest Caller" }),
    ];
    render(<LiveBookingButton />);

    expect(screen.getByTestId("button-live-booking")).toHaveAttribute(
      "data-state",
      "waiting",
    );
    expect(
      screen.getByTestId("button-live-booking-clear-all"),
    ).toHaveTextContent("Clear all");

    fireEvent.click(screen.getByTestId("button-live-booking-clear-all"));

    expect(screen.getByTestId("button-live-booking")).toHaveAttribute(
      "data-state",
      "idle",
    );
    expect(
      screen.queryByTestId("button-live-booking-clear-all"),
    ).not.toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem(`bmc.callAttention.v1.${identity}`)!),
    ).toEqual(expect.arrayContaining([20, 21, 22]));
  });

  it("puts a ringing call ahead of a waiting one", () => {
    primeEmpty();
    callsData = [
      call({ id: 31, status: "in_progress", callerName: "Ringing Now" }),
      call({ id: 30, callerName: "Waiting Still" }),
    ];
    render(<LiveBookingButton />);
    const button = screen.getByTestId("button-live-booking");
    expect(button).toHaveAttribute("data-state", "ringing");
    fireEvent.click(button);
    expect(navigate).toHaveBeenCalledWith("/bookings/new?callId=31");
  });
});

describe("the waiting flag is durable and shared", () => {
  it("still blinks after a remount — reloading the page absolves nothing", () => {
    primeEmpty();
    callsData = [call({ id: 40 })];
    const first = render(<LiveBookingButton />);
    expect(screen.getByTestId("button-live-booking")).toHaveAttribute(
      "data-state",
      "waiting",
    );
    first.unmount();
    render(<LiveBookingButton />);
    expect(screen.getByTestId("button-live-booking")).toHaveAttribute(
      "data-state",
      "waiting",
    );
  });

  it("calms down when the call is marked seen elsewhere — the Calls page and this button share one store", () => {
    primeEmpty();
    callsData = [call({ id: 41 })];
    render(<LiveBookingButton />);
    expect(screen.getByTestId("button-live-booking")).toHaveAttribute(
      "data-state",
      "waiting",
    );
    // What the Calls page row click does.
    act(() => markCallSeen(identity, 41));
    expect(screen.getByTestId("button-live-booking")).toHaveAttribute(
      "data-state",
      "idle",
    );
  });

  it("calms down once the call is booked, with no bookkeeping at all", () => {
    primeEmpty();
    callsData = [call({ id: 42 })];
    const { rerender } = render(<LiveBookingButton />);
    expect(screen.getByTestId("button-live-booking")).toHaveAttribute(
      "data-state",
      "waiting",
    );
    callsData = [call({ id: 42, status: "booked" })];
    rerender(<LiveBookingButton />);
    expect(screen.getByTestId("button-live-booking")).toHaveAttribute(
      "data-state",
      "idle",
    );
  });
});

describe("reduced motion", () => {
  it("never blinks for someone who asked for less motion", () => {
    reduceMotion = true;
    callsData = [call({ id: 50, status: "in_progress" })];
    render(<LiveBookingButton />);
    const button = screen.getByTestId("button-live-booking");
    expect(button).toHaveAttribute("data-state", "ringing");
    expect(button.className).not.toContain("animate-pulse");
  });
});
