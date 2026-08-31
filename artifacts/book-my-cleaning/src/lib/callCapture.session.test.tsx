// @vitest-environment jsdom
/**
 * A capture session has to last a whole phone call, and only the dispatcher
 * (or something that genuinely cannot recover) may end it. These tests drive
 * the real CallCaptureProvider + useLiveTranscript against a stubbed
 * SpeechRecognition and getUserMedia, and pin both halves of that:
 *
 *  - the call list saying the call is over is a *note*, never a hangup;
 *  - a transient blip reopens by itself and keeps every word;
 *  - a fatal cause stops the session and says which one it was;
 *  - Pause keeps the transcript, Resume carries on, Restart starts fresh;
 *  - Stop pressed while the permission check is still in flight wins — the
 *    answer arriving later must not switch the microphone on;
 *  - a re-announced ringing call does not restart the session or wipe the
 *    transcript;
 *  - a second call while one is being captured leaves the first alone.
 *  - changing the authenticated account stops and clears the old session, and
 *    the next account can start a fresh one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  autoListenAvailableForCompany,
  CallCaptureProvider,
  shouldTakeOverCapture,
  useCallCapture,
  useNoteCallOver,
  type CallCapture,
} from "./callCapture";

/** Vendor-prefixed recognition, faked. Every instance is recorded. */
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  /** How many of the next start() calls throw, as a real browser sometimes does. */
  static failStarts = 0;
  continuous = false;
  interimResults = false;
  lang = "";
  started = false;
  ended = false;
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
    if (FakeRecognition.failStarts > 0) {
      FakeRecognition.failStarts -= 1;
      throw new Error("InvalidStateError: recognition failed to start");
    }
    this.started = true;
    this.onstart?.();
  }
  stop() {
    this.stopped = true;
    this.end();
  }
  abort() {
    this.aborted = true;
    this.end();
  }
  /** Recognition ending on its own — a pause, or the speech service dropping. */
  end() {
    if (this.ended) return;
    this.ended = true;
    this.onend?.();
  }
  /** The browser reporting a problem, which always ends the session too. */
  fail(code: string) {
    this.onerror?.({ error: code });
    this.end();
  }
}

/** The one live session, if any: started and not yet ended. */
function openSessions(): FakeRecognition[] {
  // An instance whose start() threw never opened, so it can't be "open".
  return FakeRecognition.instances.filter((r) => r.started && !r.ended);
}

function speak(recognition: FakeRecognition, words: string) {
  recognition.onresult?.({
    resultIndex: 0,
    results: { length: 1, 0: { isFinal: true, 0: { transcript: words } } },
  });
}

/** getUserMedia whose answer the test releases by hand. */
let resolveMic: (() => void)[] = [];
/** permissions.query answers, also released by hand. */
let resolvePermission: (() => void)[] = [];
let micTrackStops: number;

beforeEach(() => {
  FakeRecognition.instances = [];
  FakeRecognition.failStarts = 0;
  resolveMic = [];
  resolvePermission = [];
  micTrackStops = 0;
  (window as unknown as Record<string, unknown>).SpeechRecognition =
    FakeRecognition;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: () =>
        new Promise<{ getTracks: () => { stop: () => void }[] }>((resolve) => {
          resolveMic.push(() =>
            resolve({
              getTracks: () => [
                {
                  stop: () => {
                    micTrackStops += 1;
                  },
                },
              ],
            }),
          );
        }),
    },
  });
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: {
      query: () =>
        new Promise<{ state: string }>((resolve) => {
          resolvePermission.push(() => resolve({ state: "granted" }));
        }),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

let capture: CallCapture | null = null;

function Probe({ live }: { live: boolean }) {
  capture = useCallCapture();
  useNoteCallOver(capture, live);
  return null;
}

function mount(
  live: boolean,
  accountId?: string | null,
  autoListenAvailable?: boolean,
) {
  const utils = render(
    <CallCaptureProvider
      accountId={accountId}
      autoListenAvailable={autoListenAvailable}
    >
      <Probe live={live} />
    </CallCaptureProvider>,
  );
  return {
    ...utils,
    setLive: (next: boolean) =>
      utils.rerender(
        <CallCaptureProvider
          accountId={accountId}
          autoListenAvailable={autoListenAvailable}
        >
          <Probe live={next} />
        </CallCaptureProvider>,
      ),
    setAccount: (next: string | null) =>
      utils.rerender(
        <CallCaptureProvider
          accountId={next}
          autoListenAvailable={autoListenAvailable}
        >
          <Probe live={live} />
        </CallCaptureProvider>,
      ),
  };
}

/** Let pending promises (permission checks, getUserMedia) settle. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Let the reconnect backoff's timers actually come round. */
async function tick(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Drive a capture session to "listening", following the given call. */
async function startCapturing(callId: number) {
  await act(async () => {
    capture!.startForCall(callId);
  });
  await act(async () => {
    resolvePermission.forEach((r) => r());
    resolvePermission = [];
  });
  await flush(); // micAlreadyAllowed answers
  await act(async () => {
    resolveMic.forEach((r) => r());
    resolveMic = [];
  });
  await flush(); // proveMicrophone answers, session opens
}

describe("phone-first company call policy", () => {
  it("recognizes ScrubbyBuilder despite capitalization and spacing", () => {
    expect(autoListenAvailableForCompany("ScrubbyBuilder")).toBe(false);
    expect(autoListenAvailableForCompany("Scrubby Builder")).toBe(false);
    expect(autoListenAvailableForCompany("Other Cleaning Co.")).toBe(true);
  });

  it("never starts a microphone automatically, but keeps manual PC capture available", async () => {
    mount(true, undefined, false);

    await act(async () => {
      capture!.startForCall(7);
    });

    expect(capture!.autoListenAvailable).toBe(false);
    expect(capture!.autoListen).toBe(false);
    expect(capture!.capturingCallId).toBeNull();
    expect(resolvePermission).toHaveLength(0);
    expect(resolveMic).toHaveLength(0);

    await act(async () => {
      capture!.startManually(7);
    });
    expect(capture!.capturingCallId).toBe(7);
    expect(resolveMic).toHaveLength(1);

    await act(async () => {
      resolveMic.forEach((resolve) => resolve());
      resolveMic = [];
    });
    await flush();

    expect(capture!.transcript.listening).toBe(true);
  });
});

describe("the call list dropping the call is a note, not a hangup", () => {
  it("keeps listening and flags the call as finished instead of cutting the microphone", async () => {
    const view = mount(true);
    await startCapturing(7);

    expect(capture!.capturingCallId).toBe(7);
    expect(capture!.transcript.listening).toBe(true);
    expect(openSessions()).toHaveLength(1);
    // The permission-probe stream must have been let go immediately, or the
    // recording light stays lit even after recognition ends.
    expect(micTrackStops).toBe(1);

    const session = openSessions()[0]!;
    await act(async () => {
      speak(session, "two bedrooms on elm street");
    });

    /**
     * Quo moves a call off `in_progress` while the two people are still
     * talking. Cutting the microphone here is the bug: the dispatcher gets a
     * note and keeps the session.
     */
    view.setLive(false);
    await flush();

    expect(capture!.callLooksOver).toBe(true);
    expect(capture!.transcript.listening).toBe(true);
    expect(capture!.capturingCallId).toBe(7);
    expect(openSessions()).toEqual([session]);

    // And the words keep coming after the list gave up on the call.
    await act(async () => {
      speak(session, "and a spare room upstairs");
    });
    expect(capture!.transcript.text).toContain("and a spare room upstairs");
  });

  it("still stops on the dispatcher's say-so, and does not reopen behind them", async () => {
    const view = mount(true);
    await startCapturing(7);
    view.setLive(false);
    await flush();
    const before = FakeRecognition.instances.length;

    await act(async () => {
      capture!.endCapture();
    });
    await tick(20);

    // stop() fires onend; a live session reopens there. A stopped one must
    // not — and the note goes away with the session.
    expect(FakeRecognition.instances.length).toBe(before);
    expect(openSessions()).toHaveLength(0);
    expect(capture!.transcript.listening).toBe(false);
    expect(capture!.transcript.status).toBe("stopped");
    expect(capture!.capturingCallId).toBeNull();
    expect(capture!.callLooksOver).toBe(false);
    // The transcript survives; the dispatcher still needs it.
    expect(capture!.transcript.stopReason).toMatch(/you stopped/i);
  });
});

describe("recognition ending on its own", () => {
  it("reopens after a natural pause without the dispatcher noticing", async () => {
    mount(true);
    await startCapturing(7);
    const first = openSessions()[0]!;
    await act(async () => {
      speak(first, "hello it's mrs fletcher");
    });

    // Chrome ends recognition after every lull. This must not read as a stop.
    await act(async () => {
      first.end();
    });
    await tick(20);

    const reopened = openSessions();
    expect(reopened).toHaveLength(1);
    expect(reopened[0]).not.toBe(first);
    expect(capture!.transcript.listening).toBe(true);
    expect(capture!.transcript.text).toContain("hello it's mrs fletcher");

    // Words keep appending to the same transcript across the reopen.
    await act(async () => {
      speak(reopened[0]!, "two bedrooms please");
    });
    expect(capture!.transcript.text).toContain("hello it's mrs fletcher");
    expect(capture!.transcript.text).toContain("two bedrooms please");
  });

  it("reconnects through a transient speech-service blip, silently the first time", async () => {
    mount(true);
    await startCapturing(7);
    const first = openSessions()[0]!;
    await act(async () => {
      speak(first, "elm street");
    });

    await act(async () => {
      first.fail("network");
    });
    await tick(20);

    expect(openSessions()).toHaveLength(1);
    expect(capture!.transcript.listening).toBe(true);
    expect(capture!.transcript.text).toContain("elm street");
    // One blip is noise. Naming it would train the dispatcher to ignore the
    // message that actually matters.
    expect(capture!.transcript.error).toBeNull();
    // And nothing let go of the call.
    expect(capture!.capturingCallId).toBe(7);
    expect(capture!.declined).toBeNull();
  });

  it("names the trouble once it keeps failing, then clears it on reconnecting", async () => {
    mount(true);
    await startCapturing(7);
    const first = openSessions()[0]!;
    await act(async () => {
      speak(first, "elm street");
    });

    // The blip, and then the reopen itself refuses to start.
    FakeRecognition.failStarts = 1;
    await act(async () => {
      first.fail("network");
    });
    await tick(20);

    expect(capture!.transcript.status).toBe("reconnecting");
    expect(capture!.transcript.error).toBeTruthy();
    expect(capture!.capturingCallId).toBe(7);

    // The backoff's second rung comes round and the session comes back.
    await tick(700);

    expect(capture!.transcript.status).toBe("listening");
    expect(capture!.transcript.error).toBeNull();
    expect(capture!.transcript.text).toContain("elm street");
    expect(openSessions()).toHaveLength(1);
  });

  it("stops for good on a fatal cause, says which, and releases the call", async () => {
    mount(true);
    await startCapturing(7);
    const first = openSessions()[0]!;
    await act(async () => {
      speak(first, "elm street");
    });

    await act(async () => {
      first.fail("not-allowed");
    });
    await tick(20);

    expect(capture!.transcript.status).toBe("stopped");
    expect(capture!.transcript.failed).toBe(true);
    expect(capture!.transcript.error).toMatch(/padlock/i);
    expect(capture!.transcript.stopReason).toMatch(/padlock/i);
    expect(openSessions()).toHaveLength(0);
    // Only a permanently fatal end may clear the claim.
    expect(capture!.capturingCallId).toBeNull();
    expect(capture!.declined).toBe("start-failed");
    // The words are still there to work from.
    expect(capture!.transcript.text).toContain("elm street");
  });
});

describe("pause, resume and restart", () => {
  it("pause keeps every word and the call, resume carries on appending", async () => {
    mount(true);
    await startCapturing(7);
    const first = openSessions()[0]!;
    await act(async () => {
      speak(first, "hello it's mrs fletcher");
    });

    await act(async () => {
      capture!.pauseCapture();
    });
    await tick(20);

    expect(capture!.transcript.status).toBe("paused");
    expect(openSessions()).toHaveLength(0);
    expect(capture!.transcript.text).toContain("hello it's mrs fletcher");
    // Paused is not finished: the dispatcher is still on this call.
    expect(capture!.capturingCallId).toBe(7);

    await act(async () => {
      capture!.resumeCapture();
    });
    await act(async () => {
      resolveMic.forEach((r) => r());
      resolveMic = [];
    });
    await flush();

    expect(capture!.transcript.status).toBe("listening");
    expect(capture!.transcript.text).toContain("hello it's mrs fletcher");

    await act(async () => {
      speak(openSessions()[0]!, "two bedrooms please");
    });
    expect(capture!.transcript.text).toContain("hello it's mrs fletcher");
    expect(capture!.transcript.text).toContain("two bedrooms please");
  });

  it("restart throws the transcript away and comes back listening", async () => {
    mount(true);
    await startCapturing(7);
    await act(async () => {
      speak(openSessions()[0]!, "wrong caller entirely");
    });

    await act(async () => {
      capture!.restartCapture();
    });
    await act(async () => {
      resolveMic.forEach((r) => r());
      resolveMic = [];
    });
    await flush();

    expect(capture!.transcript.text).toBe("");
    expect(capture!.transcript.status).toBe("listening");
    expect(openSessions()).toHaveLength(1);
    expect(capture!.capturingCallId).toBe(7);
    // No second permission prompt: restarting must not cost the dispatcher a
    // dialog in the middle of a call.
    expect(micTrackStops).toBe(2);
  });

  it("a pause is not overtaken by a permission answer arriving late", async () => {
    mount(true);

    await act(async () => {
      capture!.startManually(5);
    });
    expect(capture!.transcript.starting).toBe(true);

    await act(async () => {
      capture!.pauseCapture();
    });
    await act(async () => {
      resolveMic.forEach((r) => r());
      resolveMic = [];
    });
    await flush();

    expect(openSessions()).toHaveLength(0);
    expect(capture!.transcript.status).toBe("paused");
  });
});

describe("unmounting the provider (tab navigation)", () => {
  it("aborts the live session so the recording light goes out", async () => {
    const view = mount(true);
    await startCapturing(7);
    const session = openSessions()[0]!;

    view.unmount();

    expect(session.aborted || session.stopped).toBe(true);
    expect(openSessions()).toHaveLength(0);
  });
});

describe("changing the authenticated account", () => {
  it("stops and clears the old owner's session before the next owner can listen", async () => {
    const view = mount(true, "owner-a");
    await startCapturing(7);
    const oldSession = openSessions()[0]!;
    await act(async () => {
      speak(oldSession, "owner A private address");
    });
    expect(capture!.transcript.text).toContain("owner A private address");
    expect(capture!.capturingCallId).toBe(7);

    view.setAccount("owner-b");
    await flush();

    expect(oldSession.aborted || oldSession.stopped).toBe(true);
    expect(openSessions()).toHaveLength(0);
    expect(capture!.transcript.active).toBe(false);
    expect(capture!.transcript.text).toBe("");
    expect(capture!.transcript.interim).toBe("");
    expect(capture!.capturingCallId).toBeNull();
    expect(capture!.callLooksOver).toBe(false);

    await startCapturing(8);
    const newSession = openSessions()[0]!;
    await act(async () => {
      speak(newSession, "owner B private address");
    });

    expect(capture!.capturingCallId).toBe(8);
    expect(capture!.transcript.text).toBe("owner B private address");
    expect(capture!.transcript.text).not.toContain("owner A private address");
  });
});

describe("Stop during a pending permission check wins", () => {
  it("never opens a session when Stop arrives before getUserMedia answers", async () => {
    mount(true);

    // Dispatcher presses the button; the browser is still deciding.
    await act(async () => {
      capture!.startManually(5);
    });
    expect(capture!.transcript.starting).toBe(true);
    expect(openSessions()).toHaveLength(0);

    // Dispatcher presses Stop while the check is in flight.
    await act(async () => {
      capture!.endCapture();
    });

    // The answer arrives late — it must not switch the microphone on.
    await act(async () => {
      resolveMic.forEach((r) => r());
      resolveMic = [];
    });
    await flush();

    expect(openSessions()).toHaveLength(0);
    expect(capture!.transcript.listening).toBe(false);
    expect(capture!.transcript.starting).toBe(false);
    expect(capture!.capturingCallId).toBeNull();
  });

  it("the call leaving the list mid-check does not cancel the start — it only notes it", async () => {
    // The call is live when it is announced...
    const view = mount(true);

    await act(async () => {
      capture!.startForCall(9);
    });
    // The pending start claims the call before the asynchronous check, so
    // anything that countermands it has something to countermand.
    expect(capture!.capturingCallId).toBe(9);
    await flush();

    /**
     * ...and the list drops it while micAlreadyAllowed is still in flight.
     * That signal is not trustworthy — Quo moves a call off `in_progress`
     * mid-conversation — so the microphone still comes on and the dispatcher
     * gets the note plus a Stop button. An abandoned session is retired by
     * the silence watchdog, not by this.
     */
    view.setLive(false);
    await flush();

    await act(async () => {
      resolvePermission.forEach((r) => r());
      resolvePermission = [];
    });
    await flush();
    await act(async () => {
      resolveMic.forEach((r) => r());
      resolveMic = [];
    });
    await flush();

    expect(openSessions()).toHaveLength(1);
    expect(capture!.transcript.listening).toBe(true);
    expect(capture!.capturingCallId).toBe(9);
    expect(capture!.callLooksOver).toBe(true);

    // And Stop is right there when the dispatcher agrees it's over.
    await act(async () => {
      capture!.endCapture();
    });
    expect(openSessions()).toHaveLength(0);
    expect(capture!.capturingCallId).toBeNull();
    expect(capture!.callLooksOver).toBe(false);
  });

  it("a denied permission releases the claim so nothing appears to be following the call", async () => {
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: async () => ({ state: "prompt" }) },
    });
    mount(true);

    await act(async () => {
      capture!.startForCall(9);
    });
    await flush();

    expect(capture!.needsPermission).toBe(true);
    expect(capture!.capturingCallId).toBeNull();
    expect(openSessions()).toHaveLength(0);
  });
});

describe("a failing start never strands the session", () => {
  it("a rejecting permission check releases the claim and falls back to the one-tap prompt", async () => {
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: {
        query: () => Promise.reject(new Error("permissions backend gone")),
      },
    });
    mount(true);

    await act(async () => {
      capture!.startForCall(9);
    });
    await flush();

    // A permission check that fell over means "don't assume yes": the claim
    // is gone, nothing spins, and the owner gets the one-tap prompt rather
    // than silence.
    expect(capture!.capturingCallId).toBeNull();
    expect(capture!.transcript.starting).toBe(false);
    expect(capture!.transcript.listening).toBe(false);
    expect(capture!.needsPermission).toBe(true);
    expect(capture!.declined).toBe("needs-permission");
    expect(openSessions()).toHaveLength(0);

    // And the next press works: the manual path may ask.
    await act(async () => {
      capture!.startManually(9);
    });
    await act(async () => {
      resolveMic.forEach((r) => r());
      resolveMic = [];
    });
    await flush();
    expect(capture!.transcript.listening).toBe(true);
    expect(capture!.capturingCallId).toBe(9);
  });

  it("a rejecting mic probe resets everything and the next press works", async () => {
    let denyMic = true;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () =>
          denyMic
            ? Promise.reject(
                Object.assign(new Error("denied"), {
                  name: "NotAllowedError",
                }),
              )
            : Promise.resolve({
                getTracks: () => [{ stop: () => {} }],
              }),
      },
    });
    mount(true);

    await act(async () => {
      capture!.startManually(5);
    });
    await flush();

    // The probe failed: no spinner, no session, no phantom claim on call 5.
    expect(capture!.transcript.starting).toBe(false);
    expect(capture!.transcript.listening).toBe(false);
    expect(capture!.transcript.error).toBeTruthy();
    expect(capture!.capturingCallId).toBeNull();
    expect(capture!.declined).toBe("start-failed");
    expect(openSessions()).toHaveLength(0);

    // The dispatcher fixes the permission and presses the button again.
    denyMic = false;
    await act(async () => {
      capture!.startManually(5);
    });
    await flush();

    expect(capture!.transcript.listening).toBe(true);
    expect(capture!.capturingCallId).toBe(5);
    expect(capture!.declined).toBeNull();
    expect(openSessions()).toHaveLength(1);
  });
});

describe("a failing start never strands the session (recognition itself)", () => {
  it("recognition.start() throwing is retried on its own, keeping the claim", async () => {
    // A throw here is nearly always a reopen racing the outgoing session,
    // which is exactly the case that has to recover without anyone pressing
    // anything. The old behaviour — give up, release the call, wait for a
    // human — is what made one blip the end of the session.
    FakeRecognition.failStarts = 1;
    mount(true);

    await act(async () => {
      capture!.startManually(5);
    });
    await act(async () => {
      resolveMic.forEach((r) => r());
      resolveMic = [];
    });
    await flush();
    await tick(20);

    expect(capture!.transcript.listening).toBe(true);
    expect(capture!.capturingCallId).toBe(5);
    expect(capture!.declined).toBeNull();
    expect(openSessions()).toHaveLength(1);
  });
});

describe("every decline has a name", () => {
  it("auto-listen switched off", async () => {
    mount(true);
    await act(async () => {
      capture!.setAutoListen(false);
    });
    await act(async () => {
      capture!.startForCall(3);
    });
    await flush();

    expect(capture!.declined).toBe("auto-listen-off");
    expect(capture!.capturingCallId).toBeNull();
    expect(openSessions()).toHaveLength(0);

    // Turning auto-listen back on is the remedy, so it clears the notice.
    await act(async () => {
      capture!.setAutoListen(true);
    });
    expect(capture!.declined).toBeNull();
  });

  it("permission never granted", async () => {
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: async () => ({ state: "prompt" }) },
    });
    mount(true);

    await act(async () => {
      capture!.startForCall(3);
    });
    await flush();

    expect(capture!.needsPermission).toBe(true);
    expect(capture!.declined).toBe("needs-permission");
    expect(capture!.capturingCallId).toBeNull();
  });

  it("unsupported browser, even on a manual press", async () => {
    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
    mount(true);

    await act(async () => {
      capture!.startForCall(3);
    });
    expect(capture!.declined).toBe("unsupported");

    await act(async () => {
      capture!.startManually(3);
    });
    expect(capture!.declined).toBe("unsupported");
    expect(capture!.capturingCallId).toBeNull();
    expect(openSessions()).toHaveLength(0);
  });

  it("another call already being captured, noted from outside", async () => {
    mount(true);
    await startCapturing(7);

    await act(async () => {
      capture!.noteDecline("busy-other-call");
    });
    expect(capture!.declined).toBe("busy-other-call");
    // The running session is untouched.
    expect(capture!.capturingCallId).toBe(7);
    expect(openSessions()).toHaveLength(1);

    await act(async () => {
      capture!.clearDecline();
    });
    expect(capture!.declined).toBeNull();
  });
});

describe("a re-announced ringing call", () => {
  it("is not allowed to take over its own session", () => {
    expect(shouldTakeOverCapture(7, 7, true)).toBe(false);
  });

  it("does not restart the session or wipe the transcript even if startForCall fires again", async () => {
    mount(true);
    await startCapturing(7);
    const session = openSessions()[0]!;
    await act(async () => {
      speak(session, "hello it's mrs fletcher");
    });
    const instancesBefore = FakeRecognition.instances.length;

    // The same ringing call comes around in the next poll.
    await act(async () => {
      capture!.startForCall(7);
    });
    await flush();

    expect(FakeRecognition.instances.length).toBe(instancesBefore);
    expect(openSessions()).toEqual([session]);
    expect(capture!.transcript.text).toContain("hello it's mrs fletcher");
    expect(capture!.capturingCallId).toBe(7);
  });
});

describe("a second call while one is being captured", () => {
  it("is refused by the takeover guard", () => {
    expect(shouldTakeOverCapture(7, 8, true)).toBe(false);
  });

  it("leaves the first call's session and transcript alone", async () => {
    mount(true);
    await startCapturing(7);
    const session = openSessions()[0]!;
    await act(async () => {
      speak(session, "the first caller's address");
    });

    // The announcer consults the guard before touching the session — a
    // second in-progress call must not reach startForCall at all.
    const takeover = shouldTakeOverCapture(
      capture!.capturingCallId,
      8,
      capture!.transcript.listening,
    );
    expect(takeover).toBe(false);

    expect(capture!.capturingCallId).toBe(7);
    expect(openSessions()).toEqual([session]);
    expect(capture!.transcript.text).toContain("the first caller's address");
  });
});
