// @vitest-environment jsdom
/**
 * The phone-side live capture session (lib/live-capture.tsx), driven with a
 * fake native recognizer.
 *
 * The rules under test are the web session's rules, carried over:
 *  - no native module (Expo Go) is a named "unsupported" state, never a crash;
 *  - a denied microphone ends the session with the fix in the message;
 *  - a Stop pressed while the permission prompt is still up wins over its
 *    own answer (the mic must not come on because it was switched off);
 *  - an ordinary end is reopened, keeping every word already heard;
 *  - a fatal error ends the session through the end handler.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AppState } from "react-native";
import { render, act, cleanup } from "@testing-library/react";
import {
  useLiveCapture,
  setSpeechModuleForTests,
  setPlatformForTests,
  speechErrorMessage,
  speechErrorFatal,
  speechErrorIsAudioInterruption,
  reconnectDelayMs,
  UNSUPPORTED_MESSAGE,
  AUDIO_INTERRUPTION_STOP_REASON,
  type LiveCapture,
  type SpeechModule,
} from "./live-capture";

type Handler = (payload?: unknown) => void;

function fakeModule(overrides: Partial<SpeechModule> = {}) {
  const handlers: Record<string, Handler[]> = {};
  const mod: SpeechModule & {
    emit: (event: string, payload?: unknown) => void;
    started: number;
  } = {
    started: 0,
    start: vi.fn(() => {
      mod.started += 1;
    }),
    stop: vi.fn(),
    abort: vi.fn(),
    requestPermissionsAsync: vi.fn(async () => ({ granted: true })),
    addListener: (event, handler) => {
      (handlers[event] ??= []).push(handler);
      return {
        remove: () => {
          handlers[event] = (handlers[event] ?? []).filter(
            (h) => h !== handler,
          );
        },
      };
    },
    emit: (event, payload) => {
      for (const h of handlers[event] ?? []) h(payload);
    },
    ...overrides,
  };
  return mod;
}

let latest: LiveCapture;
function Harness() {
  latest = useLiveCapture();
  return null;
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setSpeechModuleForTests(undefined);
  setPlatformForTests(null);
});

describe("useLiveCapture", () => {
  it("without the native module: unsupported, and Start names it instead of crashing", async () => {
    setSpeechModuleForTests(null);
    render(<Harness />);
    expect(latest.supported).toBe(false);
    act(() => latest.start());
    expect(latest.error).toBe(UNSUPPORTED_MESSAGE);
    expect(latest.active).toBe(false);
  });

  it("start asks permission, then listens and accumulates final phrases across reopens", async () => {
    const mod = fakeModule();
    setSpeechModuleForTests(mod);
    render(<Harness />);
    expect(latest.supported).toBe(true);

    act(() => latest.start());
    expect(latest.status).toBe("starting");
    await flush();
    expect(mod.started).toBe(1);

    act(() => mod.emit("start"));
    expect(latest.status).toBe("listening");

    act(() =>
      mod.emit("result", {
        isFinal: false,
        results: [{ transcript: "three bed" }],
      }),
    );
    expect(latest.interim).toBe("three bed");
    act(() =>
      mod.emit("result", {
        isFinal: true,
        results: [{ transcript: "three bedrooms two baths" }],
      }),
    );
    expect(latest.text).toBe("three bedrooms two baths");
    expect(latest.interim).toBe("");

    // The recognizer ends after a lull: reopened, words kept.
    act(() => {
      mod.emit("end");
      vi.runOnlyPendingTimers();
    });
    expect(mod.started).toBe(2);
    act(() => mod.emit("start"));
    act(() =>
      mod.emit("result", {
        isFinal: true,
        results: [{ transcript: "on main street" }],
      }),
    );
    expect(latest.text).toBe("three bedrooms two baths on main street");
  });

  it("a denied permission ends the session with the fix in the message", async () => {
    const mod = fakeModule({
      requestPermissionsAsync: vi.fn(async () => ({ granted: false })),
    });
    setSpeechModuleForTests(mod);
    render(<Harness />);
    act(() => latest.start());
    await flush();
    expect(mod.started).toBe(0);
    expect(latest.status).toBe("stopped");
    expect(latest.failed).toBe(true);
    expect(latest.error).toContain("microphone is blocked");
    expect(latest.diagnostics.permission).toBe("denied");
    expect(latest.diagnostics.lastTranscriptStage).toBe("permission-denied");
  });

  it("Stop pressed while the permission prompt is up wins over its own answer", async () => {
    let resolvePermission: (v: { granted: boolean }) => void = () => {};
    const mod = fakeModule({
      requestPermissionsAsync: vi.fn(
        () =>
          new Promise<{ granted: boolean }>((resolve) => {
            resolvePermission = resolve;
          }),
      ),
    });
    setSpeechModuleForTests(mod);
    render(<Harness />);
    act(() => latest.start());
    act(() => latest.stop());
    expect(latest.status).toBe("stopped");
    await act(async () => {
      resolvePermission({ granted: true });
      await Promise.resolve();
    });
    // The late "yes" must not switch the microphone on.
    expect(mod.started).toBe(0);
    expect(latest.status).toBe("stopped");
    expect(latest.stopReason).toBe("You stopped listening.");
  });

  it("does not update state or start after unmounting during the permission prompt", async () => {
    let resolvePermission: (v: { granted: boolean }) => void = () => {};
    const mod = fakeModule({
      requestPermissionsAsync: vi.fn(
        () =>
          new Promise<{ granted: boolean }>((resolve) => {
            resolvePermission = resolve;
          }),
      ),
    });
    setSpeechModuleForTests(mod);

    let renderCount = 0;
    function MountedHarness() {
      renderCount += 1;
      latest = useLiveCapture();
      return null;
    }

    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const view = render(<MountedHarness />);
    act(() => latest.start());
    const rendersBeforeUnmount = renderCount;

    view.unmount();
    await act(async () => {
      resolvePermission({ granted: true });
      await Promise.resolve();
    });

    expect(renderCount).toBe(rendersBeforeUnmount);
    expect(mod.started).toBe(0);
    expect(
      consoleError.mock.calls
        .flat()
        .filter(
          (argument) =>
            typeof argument === "string" &&
            /cannot update an unmounted component/i.test(argument),
        ),
    ).toHaveLength(0);
    consoleError.mockRestore();
  });

  it("does not restart after unmounting while a reconnect backoff is pending", async () => {
    const mod = fakeModule();
    setSpeechModuleForTests(mod);

    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const view = render(<Harness />);
      act(() => latest.start());
      await flush();
      expect(mod.started).toBe(1);

      // The first reconnect is immediate. Leave its native start without a
      // matching start event, then the next interruption enters the 500ms
      // backoff rung.
      act(() => mod.emit("end"));
      act(() => vi.runOnlyPendingTimers());
      expect(mod.started).toBe(2);
      act(() => mod.emit("end"));
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      view.unmount();
      act(() => vi.advanceTimersByTime(5_000));

      expect(mod.started).toBe(2);
      expect(
        consoleError.mock.calls
          .flat()
          .filter(
            (argument) =>
              typeof argument === "string" &&
              /unmounted component|state update on.*mounted/i.test(argument),
          ),
      ).toHaveLength(0);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not strand the next form when abort throws during unmount", async () => {
    const mod = fakeModule({
      abort: vi.fn(() => {
        throw new Error("native abort failed");
      }),
    });
    setSpeechModuleForTests(mod);

    const firstForm = render(<Harness />);
    act(() => latest.start());
    await flush();
    act(() => mod.emit("start"));
    expect(latest.status).toBe("listening");

    firstForm.unmount();
    render(<Harness />);
    act(() => latest.start());
    await flush();

    expect(mod.started).toBe(2);
    act(() => mod.emit("start"));
    expect(latest.status).toBe("listening");
  });

  it("stops in the background and does not resume when the app returns", async () => {
    let signalAppState: ((state: string) => void) | undefined;
    const addEventListener = vi
      .spyOn(AppState, "addEventListener")
      .mockImplementation((_event, listener) => {
        signalAppState = listener as (state: string) => void;
        return { remove: vi.fn() };
      });
    const mod = fakeModule();
    setSpeechModuleForTests(mod);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      render(<Harness />);
      act(() => latest.start());
      await flush();
      act(() => mod.emit("start"));
      expect(latest.status).toBe("listening");

      act(() => signalAppState?.("background"));
      expect(mod.abort).toHaveBeenCalledTimes(1);
      expect(latest.status).toBe("stopped");
      expect(latest.active).toBe(false);
      expect(latest.stopReason).toBe(
        "Listening stopped because the app went into the background.",
      );
      expect(latest.error).toBeNull();
      expect(latest.interim).toBe("");

      act(() => signalAppState?.("active"));
      act(() => vi.advanceTimersByTime(10_000));
      expect(mod.started).toBe(1);
      const lifecycleWarnings = [
        ...consoleError.mock.calls,
        ...consoleWarn.mock.calls,
      ]
        .flat()
        .filter(
          (argument) =>
            typeof argument === "string" &&
            /unmounted component|state update on.*mounted|stale/i.test(
              argument,
            ),
        );
      expect(lifecycleWarnings).toHaveLength(0);
      expect(latest.status).toBe("stopped");
      expect(latest.active).toBe(false);
    } finally {
      addEventListener.mockRestore();
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it("cancels a pending reconnect when the app backgrounds", async () => {
    let signalAppState: ((state: string) => void) | undefined;
    const addEventListener = vi
      .spyOn(AppState, "addEventListener")
      .mockImplementation((_event, listener) => {
        signalAppState = listener as (state: string) => void;
        return { remove: vi.fn() };
      });
    const mod = fakeModule();
    setSpeechModuleForTests(mod);

    try {
      render(<Harness />);
      act(() => latest.start());
      await flush();
      expect(mod.started).toBe(1);

      // The first reconnect is immediate. The second interruption leaves a
      // 500ms timer pending, which must be cleared by backgrounding.
      act(() => {
        mod.emit("end");
        vi.runOnlyPendingTimers();
      });
      act(() => mod.emit("end"));
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      act(() => signalAppState?.("background"));
      act(() => vi.advanceTimersByTime(10_000));
      expect(mod.started).toBe(2);
      expect(latest.status).toBe("stopped");
      expect(latest.active).toBe(false);
    } finally {
      addEventListener.mockRestore();
    }
  });

  it.each([
    ["ios", "interrupted"],
    ["android", "audio-capture"],
  ] as const)(
    "%s stops recoverably on a phone audio interruption and returns to the form without restarting",
    async (platform, errorCode) => {
      setPlatformForTests(platform);
      const mod = fakeModule();
      setSpeechModuleForTests(mod);
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const consoleWarn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      try {
        const firstForm = render(<Harness />);
        act(() => latest.start());
        await flush();
        act(() => mod.emit("start"));
        act(() =>
          mod.emit("result", {
            isFinal: false,
            results: [{ transcript: "three bed" }],
          }),
        );
        expect(latest.status).toBe("listening");
        expect(latest.interim).toBe("three bed");

        act(() =>
          mod.emit("error", {
            error: errorCode,
            message: "system audio took the microphone",
          }),
        );

        expect(mod.abort).toHaveBeenCalledTimes(1);
        expect(latest.status).toBe("stopped");
        expect(latest.active).toBe(false);
        expect(latest.failed).toBe(false);
        expect(latest.error).toBeNull();
        expect(latest.interim).toBe("");
        expect(latest.stopReason).toBe(AUDIO_INTERRUPTION_STOP_REASON);
        expect(latest.diagnostics.recognizerError).toBe(errorCode);

        // The owner can immediately ask to Listen again. That request waits
        // for the interrupted native run's terminal event instead of letting
        // a stale callback stop or duplicate the next recognizer.
        act(() => latest.start());
        expect(latest.status).toBe("starting");
        expect(mod.started).toBe(1);
        act(() =>
          mod.emit("error", {
            error: errorCode,
            message: "late error from the retired recognizer",
          }),
        );
        expect(latest.status).toBe("starting");
        act(() => mod.emit("end"));
        await flush();
        expect(mod.started).toBe(2);
        act(() => mod.emit("start"));
        expect(latest.status).toBe("listening");
        act(() => vi.advanceTimersByTime(10_000));
        expect(mod.started).toBe(2);

        // The same retirement barrier survives a booking-form remount.
        act(() =>
          mod.emit("error", {
            error: errorCode,
            message: "second system audio takeover",
          }),
        );
        expect(latest.status).toBe("stopped");
        firstForm.unmount();
        render(<Harness />);
        act(() => latest.start());
        expect(latest.status).toBe("starting");
        expect(mod.started).toBe(2);
        act(() => {
          mod.emit("error", {
            error: errorCode,
            message: "late error after the form remounted",
          });
          mod.emit("end");
        });
        await flush();

        expect(mod.started).toBe(3);
        act(() => mod.emit("start"));
        expect(latest.status).toBe("listening");
        expect(latest.active).toBe(true);
        act(() => vi.advanceTimersByTime(10_000));
        expect(mod.started).toBe(3);
        const lifecycleWarnings = [
          ...consoleError.mock.calls,
          ...consoleWarn.mock.calls,
        ]
          .flat()
          .filter(
            (argument) =>
              typeof argument === "string" &&
              /unmounted component|state update on.*mounted|stale/i.test(
                argument,
              ),
          );
        expect(lifecycleWarnings).toHaveLength(0);
      } finally {
        consoleError.mockRestore();
        consoleWarn.mockRestore();
      }
    },
  );

  it("a fatal error ends the session through the end handler and is named", async () => {
    const mod = fakeModule();
    setSpeechModuleForTests(mod);
    render(<Harness />);
    act(() => latest.start());
    await flush();
    act(() => mod.emit("start"));
    act(() => mod.emit("error", { error: "not-allowed", message: "denied" }));
    // Not yet — one way out of a session, and it's the end event.
    expect(latest.status).toBe("listening");
    act(() => mod.emit("end"));
    expect(latest.status).toBe("stopped");
    expect(latest.failed).toBe(true);
    expect(latest.error).toContain("microphone is blocked");
    expect(latest.diagnostics.recognizerError).toBe("not-allowed");
    expect(latest.diagnostics.lastTranscriptStage).toBe("recognizer-error");
    // And nothing reopened underneath the failure.
    act(() => vi.runOnlyPendingTimers());
    expect(mod.started).toBe(1);
  });

  it("iOS cumulative finals (each final extends the full session text): replaces instead of doubling", async () => {
    // iOS with continuous mode sends cumulative transcripts per isFinal event —
    // results[0].transcript grows with each settled phrase rather than
    // containing only the new words.  The platform-aware accumulator must
    // replace the current run's contribution rather than appending again.
    setPlatformForTests("ios");
    const mod = fakeModule();
    setSpeechModuleForTests(mod);
    render(<Harness />);
    act(() => latest.start());
    await flush();
    act(() => mod.emit("start"));

    // First utterance settles.
    act(() =>
      mod.emit("result", {
        isFinal: true,
        results: [{ transcript: "three bedrooms two baths" }],
      }),
    );
    expect(latest.text).toBe("three bedrooms two baths");

    // iOS extends the cumulative transcript within the same run.
    act(() =>
      mod.emit("result", {
        isFinal: true,
        results: [{ transcript: "three bedrooms two baths on Main Street" }],
      }),
    );
    // Must replace, not append "…on Main Street" onto "three bedrooms two baths".
    expect(latest.text).toBe("three bedrooms two baths on Main Street");
  });

  it("iOS cumulative finals after a recognizer reopen: pre-reopen words are kept and new cumulative rebases correctly", async () => {
    // When iOS fires "end" after a natural pause and we reopen, the new run
    // has a fresh cumulative baseline.  Words from the first run must survive,
    // and the new run's cumulative finals must not duplicate them.
    setPlatformForTests("ios");
    const mod = fakeModule();
    setSpeechModuleForTests(mod);
    render(<Harness />);
    act(() => latest.start());
    await flush();

    // ── Run 1 ──
    act(() => mod.emit("start")); // baseline = ""
    act(() =>
      mod.emit("result", {
        isFinal: true,
        results: [{ transcript: "three bedrooms two baths" }],
      }),
    );
    expect(latest.text).toBe("three bedrooms two baths");

    // Recognizer ends naturally → scheduleReopen (delay = 0 on first attempt).
    act(() => {
      mod.emit("end");
      vi.runOnlyPendingTimers();
    });

    // ── Run 2 ──
    act(() => mod.emit("start")); // baseline = "three bedrooms two baths"
    // iOS sends cumulative text for this run: just the new sentence.
    act(() =>
      mod.emit("result", {
        isFinal: true,
        results: [{ transcript: "on Main Street" }],
      }),
    );
    // Pre-run words + new cumulative, no duplication.
    expect(latest.text).toBe("three bedrooms two baths on Main Street");

    // A further iOS extension within run 2.
    act(() =>
      mod.emit("result", {
        isFinal: true,
        results: [{ transcript: "on Main Street Edmonton" }],
      }),
    );
    expect(latest.text).toBe(
      "three bedrooms two baths on Main Street Edmonton",
    );
  });

  it("Android segment finals (each final is a new phrase only, no session restart between segments): appends correctly", async () => {
    // Android finalises utterances mid-session without firing an "end" event
    // between them — each isFinal result contains only the new words.
    setPlatformForTests("android");
    const mod = fakeModule();
    setSpeechModuleForTests(mod);
    render(<Harness />);
    act(() => latest.start());
    await flush();
    act(() => mod.emit("start"));

    // First segment.
    act(() =>
      mod.emit("result", {
        isFinal: true,
        results: [{ transcript: "three bedrooms" }],
      }),
    );
    expect(latest.text).toBe("three bedrooms");

    // Second segment — no "end" event, session keeps going.
    act(() =>
      mod.emit("result", {
        isFinal: true,
        results: [{ transcript: "two baths on Main Street" }],
      }),
    );
    // Must append the independent segment.
    expect(latest.text).toBe("three bedrooms two baths on Main Street");
  });

  it("Android repeated-prefix segment: second segment that starts with the first is appended, not replaced", async () => {
    // Regression: a user can legitimately say a segment that begins with the
    // same words as the previous final (e.g. correcting or extending a phrase).
    // The Android path must always append regardless of any content overlap.
    setPlatformForTests("android");
    const mod = fakeModule();
    setSpeechModuleForTests(mod);
    render(<Harness />);
    act(() => latest.start());
    await flush();
    act(() => mod.emit("start"));

    act(() =>
      mod.emit("result", {
        isFinal: true,
        results: [{ transcript: "three bedrooms" }],
      }),
    );
    expect(latest.text).toBe("three bedrooms");

    // New segment that starts with the previous final — must append, not replace.
    act(() =>
      mod.emit("result", {
        isFinal: true,
        results: [{ transcript: "three bedrooms, two bathrooms" }],
      }),
    );
    expect(latest.text).toBe("three bedrooms three bedrooms, two bathrooms");
  });

  it.each(["ios", "android"] as const)(
    "%s uses the primary native result when alternatives are also returned",
    async (platform) => {
      setPlatformForTests(platform);
      const mod = fakeModule();
      setSpeechModuleForTests(mod);
      render(<Harness />);
      act(() => latest.start());
      await flush();
      act(() => mod.emit("start"));

      act(() =>
        mod.emit("result", {
          isFinal: true,
          results: [
            { transcript: "hi this is Jane Doe" },
            { transcript: "hi this is Jane Dough" },
            { transcript: "hi this was Jane Doe" },
          ],
        }),
      );

      expect(latest.text).toBe("hi this is Jane Doe");
    },
  );

  it("clear wipes the words without touching the session", async () => {
    const mod = fakeModule();
    setSpeechModuleForTests(mod);
    render(<Harness />);
    act(() => latest.start());
    await flush();
    act(() => mod.emit("start"));
    act(() =>
      mod.emit("result", { isFinal: true, results: [{ transcript: "hi" }] }),
    );
    act(() => latest.clear());
    expect(latest.text).toBe("");
    expect(latest.status).toBe("listening");
  });

  it("iOS clear restarts the recognizer so cumulative finals can't restore cleared words", async () => {
    // On iOS the native run's transcript is cumulative since the last start().
    // If clear() only resets state without restarting the run, the very next
    // isFinal result re-applies (runBaseline + full cumulative phrase), putting
    // the cleared words back on screen.
    setPlatformForTests("ios");
    const mod = fakeModule();
    setSpeechModuleForTests(mod);
    render(<Harness />);
    act(() => latest.start());
    await flush();

    // Run 1 settles some text.
    act(() => mod.emit("start")); // baseline = ""
    act(() =>
      mod.emit("result", {
        isFinal: true,
        results: [{ transcript: "three bedrooms two baths" }],
      }),
    );
    expect(latest.text).toBe("three bedrooms two baths");

    // Owner clears.  On iOS this must abort the run so the next run starts fresh.
    act(() => {
      latest.clear();
      // The abort triggers "end", which calls scheduleReopen at delay 0.
      mod.emit("end");
      vi.runOnlyPendingTimers();
    });
    expect(latest.text).toBe("");

    // Run 2 opens.  New baseline must be "" (text was cleared before start).
    act(() => mod.emit("start"));

    // iOS cumulative result for run 2 — does NOT include the cleared run's text.
    act(() =>
      mod.emit("result", {
        isFinal: true,
        results: [{ transcript: "on Main Street" }],
      }),
    );
    // Must be only the new words, not "three bedrooms two baths on Main Street".
    expect(latest.text).toBe("on Main Street");
    expect(latest.status).toBe("listening");
  });
});

describe("error vocabulary (web parity)", () => {
  it("quiet moments and deliberate stops are not failures", () => {
    expect(speechErrorMessage("no-speech")).toBeNull();
    expect(speechErrorMessage("aborted")).toBeNull();
    expect(speechErrorMessage("speech-timeout")).toBeNull();
  });
  it("permanent causes are fatal, blips are not", () => {
    expect(speechErrorFatal("not-allowed")).toBe(true);
    expect(speechErrorFatal("audio-capture")).toBe(true);
    expect(speechErrorFatal("language-not-supported")).toBe(true);
    expect(speechErrorFatal("network")).toBe(false);
    expect(speechErrorFatal("busy")).toBe(false);
    expect(speechErrorFatal("interrupted")).toBe(false);
  });
  it("recognizes the platform-specific phone audio interruption codes", () => {
    expect(speechErrorIsAudioInterruption("interrupted")).toBe(true);
    expect(speechErrorIsAudioInterruption("audio-capture")).toBe(true);
    expect(speechErrorIsAudioInterruption("busy")).toBe(false);
    expect(speechErrorIsAudioInterruption("network")).toBe(false);
  });
  it("the backoff ladder starts at zero and clamps", () => {
    expect(reconnectDelayMs(0)).toBe(0);
    expect(reconnectDelayMs(2)).toBe(1000);
    expect(reconnectDelayMs(99)).toBe(8000);
  });
});
