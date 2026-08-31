// @vitest-environment jsdom
/**
 * The calls list must keep being polled while a capture session is following
 * a call — even on the booking desk, where the alert normally steps aside.
 * A cached `in_progress` row that never refreshes is exactly what would
 * strand the microphone on after everyone has hung up.
 *
 * These tests render the real LiveCallAlert inside the real
 * CallCaptureProvider, with the query hook stubbed so the refetch interval it
 * was asked for is observable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

type FakeCall = {
  id: number;
  status: string;
  direction: string;
  startedAt: string;
  callerName: string;
  callerPhone: string;
  serviceRequested: string | null;
};

let callsData: FakeCall[] = [];
let lastQueryOptions: {
  refetchInterval: number | false;
  enabled: boolean;
} | null = null;

vi.mock("@workspace/api-client-react", () => ({
  useListCalls: (
    _params: unknown,
    options: { query: { refetchInterval: number | false; enabled: boolean } },
  ) => {
    lastQueryOptions = options.query;
    return { data: callsData };
  },
  getListCallsQueryKey: () => ["/api/calls"],
  useGetCurrentUser: () => ({
    data: {
      role: "owner",
      canTakeLiveCalls: true,
      email: userEmail,
      companyName: "Sparkle",
    },
  }),
}));

/**
 * The announced/primed sets inside LiveCallAlert are module scope on purpose,
 * which means they outlive a test. A fresh session per test (a new email)
 * makes the component reset them itself, exactly as it would for a real
 * sign-out/sign-in — so every test starts with an unprimed page load.
 */
let userEmail = "owner@example.com";
let userCounter = 0;

let location = "/bookings/new";
const navigate = vi.fn();
vi.mock("wouter", () => ({
  useLocation: () => [location, navigate],
}));

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast }),
}));
vi.mock("@/lib/chime", () => ({
  playCallAlert: vi.fn(),
  startRinging: vi.fn(),
  stopRinging: vi.fn(),
}));
vi.mock("@/lib/desktopNotify", () => ({ popUp: vi.fn() }));

import { playCallAlert, startRinging, stopRinging } from "@/lib/chime";
import { LiveCallAlert } from "./LiveCallAlert";
import {
  CallCaptureProvider,
  useCallCapture,
  type CallCapture,
} from "@/lib/callCapture";

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  stopped = false;
  aborted = false;
  onstart: (() => void) | null = null;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    this.onstart?.();
  }
  stop() {
    this.stopped = true;
    this.onend?.();
  }
  abort() {
    this.aborted = true;
    this.onend?.();
  }
}

function openSessions(): FakeRecognition[] {
  return FakeRecognition.instances.filter((r) => !r.stopped && !r.aborted);
}

beforeEach(() => {
  userCounter += 1;
  userEmail = `owner${userCounter}@example.com`;
  FakeRecognition.instances = [];
  callsData = [];
  lastQueryOptions = null;
  location = "/bookings/new";
  document.title = "Dashboard";
  (window as unknown as Record<string, unknown>).SpeechRecognition =
    FakeRecognition;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => ({
        getTracks: () => [{ stop: () => {} }],
      }),
    },
  });
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: { query: async () => ({ state: "granted" }) },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

let capture: CallCapture | null = null;
function Probe() {
  capture = useCallCapture();
  return null;
}

function mount() {
  const utils = render(
    <CallCaptureProvider>
      <Probe />
      <LiveCallAlert />
    </CallCaptureProvider>,
  );
  return {
    ...utils,
    refresh: () =>
      utils.rerender(
        <CallCaptureProvider>
          <Probe />
          <LiveCallAlert />
        </CallCaptureProvider>,
      ),
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function inProgressCall(id: number): FakeCall {
  return {
    id,
    status: "in_progress",
    direction: "inbound",
    startedAt: new Date().toISOString(),
    callerName: "Mrs Fletcher",
    callerPhone: "555-0100",
    serviceRequested: null,
  };
}

describe("a call already live when the page loads", () => {
  it("starts capture instead of filing the call away as history", async () => {
    location = "/schedule";
    callsData = [inProgressCall(7)];
    mount();
    await flush(); // priming pass + permission check + mic probe

    expect(capture!.capturingCallId).toBe(7);
    expect(capture!.transcript.listening).toBe(true);
    expect(openSessions()).toHaveLength(1);
    // Primed as seen: no toast for a call the list already shows.
    expect(toast).not.toHaveBeenCalled();
  });

  it("raises the one-tap prompt instead when the microphone was never granted", async () => {
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: async () => ({ state: "prompt" }) },
    });
    location = "/schedule";
    callsData = [inProgressCall(7)];
    mount();
    await flush();

    expect(capture!.needsPermission).toBe(true);
    expect(capture!.declined).toBe("needs-permission");
    expect(capture!.capturingCallId).toBeNull();
    expect(openSessions()).toHaveLength(0);
  });

  it("does not steal the microphone from a session already running", async () => {
    location = "/schedule";
    callsData = [];
    const view = mount();
    await flush();

    await act(async () => {
      capture!.startManually(3);
    });
    await flush();
    expect(capture!.transcript.listening).toBe(true);

    // A remount elsewhere would re-prime; simulate by rendering fresh state
    // with a different live call — the guard must keep the session on 3.
    callsData = [inProgressCall(9)];
    view.refresh();
    await flush();

    expect(capture!.capturingCallId).toBe(3);
    expect(openSessions()).toHaveLength(1);
  });

  it("a second live call announced later names the busy decline", async () => {
    location = "/schedule";
    callsData = [inProgressCall(7)];
    const view = mount();
    await flush(); // auto-starts for call 7

    expect(capture!.capturingCallId).toBe(7);

    callsData = [inProgressCall(7), inProgressCall(8)];
    view.refresh();
    await flush();

    expect(capture!.capturingCallId).toBe(7);
    expect(capture!.declined).toBe("busy-other-call");
  });
});

describe("polling while a session follows a call", () => {
  it("does not poll on the booking desk when nothing is being captured", async () => {
    location = "/bookings/new";
    mount();
    await flush();
    expect(lastQueryOptions?.enabled).toBe(true);
    expect(lastQueryOptions?.refetchInterval).toBe(false);
  });

  it("keeps polling on the booking desk while a session is following a call", async () => {
    location = "/bookings/new";
    callsData = [inProgressCall(7)];
    const view = mount();
    await flush();

    // The dispatcher starts capturing call 7 from the desk.
    await act(async () => {
      capture!.startManually(7);
    });
    await flush();
    expect(capture!.capturingCallId).toBe(7);

    view.refresh();
    await flush();

    // Something must notice the hangup, so the poll may not stop.
    expect(lastQueryOptions?.refetchInterval).toBe(10_000);
  });

  it("polls everywhere else regardless of capture", async () => {
    location = "/schedule";
    mount();
    await flush();
    expect(lastQueryOptions?.refetchInterval).toBe(10_000);
  });

  it("a second call announced while one is being captured leaves the first alone", async () => {
    location = "/schedule";
    callsData = [inProgressCall(7)];
    const view = mount();
    await flush(); // first list is primed, not announced

    await act(async () => {
      capture!.startManually(7);
    });
    await flush();
    expect(capture!.transcript.listening).toBe(true);
    const sessionsBefore = openSessions();
    expect(sessionsBefore).toHaveLength(1);

    // A second caller rings in on the next poll and gets announced.
    callsData = [inProgressCall(7), inProgressCall(8)];
    view.refresh();
    await flush();

    // The alert fired for call 8 but the microphone stayed with call 7.
    expect(capture!.capturingCallId).toBe(7);
    expect(openSessions()).toEqual(sessionsBefore);
    expect(capture!.transcript.listening).toBe(true);
  });

  it("notes the followed call as finished without cutting the microphone", async () => {
    location = "/bookings/new";
    callsData = [inProgressCall(7)];
    const view = mount();
    await flush();

    await act(async () => {
      capture!.startManually(7);
    });
    await flush();
    expect(capture!.transcript.listening).toBe(true);
    expect(openSessions()).toHaveLength(1);

    /**
     * A fresh poll says the call is over. Quo does that while the two people
     * are still talking, so this is a note beside the transcript and nothing
     * more — switching the microphone off here is the bug that killed live
     * capture a few seconds into every real call.
     */
    callsData = [{ ...inProgressCall(7), status: "completed" }];
    view.refresh();
    await flush();

    expect(capture!.callLooksOver).toBe(true);
    expect(capture!.transcript.listening).toBe(true);
    expect(capture!.capturingCallId).toBe(7);
    expect(openSessions()).toHaveLength(1);
  });

  it("keeps polling after the followed call left the list, so the note can go away again", async () => {
    location = "/bookings/new";
    callsData = [inProgressCall(7)];
    const view = mount();
    await flush();

    await act(async () => {
      capture!.startManually(7);
    });
    await flush();

    callsData = [{ ...inProgressCall(7), status: "completed" }];
    view.refresh();
    await flush();
    expect(lastQueryOptions?.refetchInterval).toBe(10_000);

    // Quo caught up: the call is live again and the note retracts itself.
    callsData = [inProgressCall(7)];
    view.refresh();
    await flush();
    expect(capture!.callLooksOver).toBe(false);
  });
});

describe("the phone rings and the desk opens by itself", () => {
  function completedCall(id: number): FakeCall {
    return { ...inProgressCall(id), status: "completed" };
  }

  it("a fresh ringing call starts the repeating ring and opens the booking desk", async () => {
    location = "/schedule";
    callsData = [];
    const view = mount();
    await flush(); // primed with an empty list

    callsData = [inProgressCall(41)];
    view.refresh();
    await flush();

    expect(startRinging).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/bookings/new?callId=41");
    // The desk shows the call — a toast on top would just repeat it.
    expect(toast).not.toHaveBeenCalled();
  });

  it("does not barge into the booking desk when someone is already there", async () => {
    location = "/bookings/new";
    callsData = [];
    const view = mount();
    await flush();

    callsData = [inProgressCall(42)];
    view.refresh();
    await flush();

    expect(startRinging).toHaveBeenCalled(); // still rings — they may be away
    expect(navigate).not.toHaveBeenCalled();
  });

  it("a call that already ended gets one alert sound, no ring, no navigation", async () => {
    location = "/schedule";
    callsData = [];
    const view = mount();
    await flush();

    callsData = [completedCall(43)];
    view.refresh();
    await flush();

    expect(playCallAlert).toHaveBeenCalled();
    expect(startRinging).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalled(); // "just came off the phone" still shows
  });

  it("falls silent the moment the call leaves the live list", async () => {
    location = "/schedule";
    callsData = [];
    const view = mount();
    await flush();

    callsData = [inProgressCall(44)];
    view.refresh();
    await flush();
    expect(startRinging).toHaveBeenCalledTimes(1);

    callsData = [completedCall(44)];
    view.refresh();
    await flush();

    expect(stopRinging).toHaveBeenCalled();
    // Ended is not fresh news twice: no second ring for the same call.
    expect(startRinging).toHaveBeenCalledTimes(1);
  });

  it("dismisses the banner, ring, and title flash, and stays quiet after completion", async () => {
    location = "/schedule";
    callsData = [];
    const view = mount();
    await flush();

    callsData = [inProgressCall(46)];
    view.refresh();
    await flush();

    expect(
      document.querySelector('[data-testid="banner-incoming-call"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain(
      "Mrs Fletcher is currently connected to the receptionist",
    );
    expect(document.title).toContain("connected to receptionist");

    act(() => {
      (
        document.querySelector(
          '[data-testid="button-dismiss-incoming-call"]',
        ) as HTMLButtonElement
      ).click();
    });

    expect(
      document.querySelector('[data-testid="banner-incoming-call"]'),
    ).toBeNull();
    expect(stopRinging).toHaveBeenCalled();
    expect(document.title).toBe("Dashboard");

    callsData = [{ ...inProgressCall(46), status: "completed" }];
    view.refresh();
    await flush();
    expect(
      document.querySelector('[data-testid="banner-incoming-call"]'),
    ).toBeNull();
  });

  it("a call already live at page load does not hijack where the owner navigated", async () => {
    location = "/schedule";
    callsData = [inProgressCall(45)];
    mount();
    await flush();

    // The list on screen and the red banner already show it; the deliberate
    // page visit stands.
    expect(navigate).not.toHaveBeenCalled();
  });
});
