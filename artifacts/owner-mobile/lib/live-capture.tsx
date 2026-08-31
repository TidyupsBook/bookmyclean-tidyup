import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";

/**
 * Live speech-to-text from the owner's own phone microphone.
 *
 * The web dashboard already does this with the browser's SpeechRecognition —
 * Chrome/Edge only, which is exactly the browsers a phone doesn't have. Here
 * the same job runs on the phone's native recognizer (expo-speech-recognition)
 * while the call is on speaker, and the words feed the very same server-side
 * extraction the web uses (POST /booking-drafts). No extraction rules live on
 * the phone.
 *
 * The native module is not part of Expo Go, so it is loaded lazily and its
 * absence is a *named* state ("needs the installed app build"), never a crash
 * or a button that does nothing.
 *
 * The design rules are the web session's rules, carried over:
 *  1. While the owner still wants to listen, an end is something to reopen —
 *     not something to report. Only a cause that can never recover (refused
 *     microphone, no recognizer, no speech pack) ends the session. Everything
 *     else gets a short backoff and another go, keeping every word heard.
 *  2. Every async start carries a cancellation token: a Stop pressed while
 *     the permission prompt is still up must not be overtaken by its own
 *     answer.
 *  3. Failures are named in plain words with the fix in them — a microphone
 *     icon on with no words is indistinguishable from a broken feature.
 */

type SpeechErrorEvent = { error: string; message?: string };
type SpeechResultEvent = {
  isFinal: boolean;
  results: { transcript: string }[];
};
type SpeechSubscription = { remove: () => void };

export type SpeechModule = {
  start: (options: {
    lang: string;
    interimResults: boolean;
    continuous: boolean;
  }) => void;
  stop: () => void;
  abort: () => void;
  requestPermissionsAsync: () => Promise<{
    granted: boolean;
    canAskAgain?: boolean;
  }>;
  addListener: (
    event: "start" | "end" | "result" | "error",
    handler: (payload?: unknown) => void,
  ) => SpeechSubscription;
};

/**
 * Loaded lazily and guarded because `expo-speech-recognition` calls
 * `requireNativeModule` at import time — inside Expo Go (which doesn't bundle
 * this module) the import itself throws. In the installed dev/App Store build
 * it resolves normally.
 */
let cachedModule: SpeechModule | null | undefined;
let coordinatorModule: SpeechModule | null = null;
let coordinatorEndSubscription: SpeechSubscription | null = null;
let nativeRunOutstanding = false;
let retiringNativeRun = false;
let consumeRetirementEnd = false;
let pendingStartAfterRetirement: {
  owner: symbol;
  start: () => void;
} | null = null;

function resetSpeechCoordinator() {
  coordinatorEndSubscription?.remove();
  coordinatorEndSubscription = null;
  coordinatorModule = null;
  nativeRunOutstanding = false;
  retiringNativeRun = false;
  consumeRetirementEnd = false;
  pendingStartAfterRetirement = null;
}

function ensureSpeechCoordinator(mod: SpeechModule) {
  if (coordinatorModule === mod) return;
  resetSpeechCoordinator();
  coordinatorModule = mod;
  // This listener intentionally outlives booking-form hooks. It prevents an
  // aborted recognizer's terminal event from being lost between unmount and
  // remount, where it could otherwise affect the next hook's new session.
  coordinatorEndSubscription = mod.addListener("end", () => {
    if (!retiringNativeRun) return;
    nativeRunOutstanding = false;
    retiringNativeRun = false;
    consumeRetirementEnd = true;
    const pending = pendingStartAfterRetirement;
    void Promise.resolve().then(() => {
      // Hook listeners for this same native event have now had a chance to
      // observe and consume the retirement marker.
      consumeRetirementEnd = false;
      if (pending && pendingStartAfterRetirement === pending) {
        pendingStartAfterRetirement = null;
        pending.start();
      }
    });
  });
}

export function loadSpeechModule(): SpeechModule | null {
  if (cachedModule !== undefined) {
    if (cachedModule) ensureSpeechCoordinator(cachedModule);
    return cachedModule;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("expo-speech-recognition") as {
      ExpoSpeechRecognitionModule: SpeechModule;
    };
    cachedModule = mod.ExpoSpeechRecognitionModule ?? null;
  } catch {
    cachedModule = null;
  }
  if (cachedModule) ensureSpeechCoordinator(cachedModule);
  return cachedModule;
}

/** Test seam: install a fake recognizer (or null to simulate Expo Go). */
export function setSpeechModuleForTests(mod: SpeechModule | null | undefined) {
  resetSpeechCoordinator();
  cachedModule = mod;
}

/**
 * Test seam: override the platform detection so iOS and Android accumulation
 * paths can be exercised in a jsdom environment where Platform.OS is "web".
 * Call with null to restore the real Platform.OS.
 */
let platformOverride: "ios" | "android" | null = null;
export function setPlatformForTests(p: "ios" | "android" | null) {
  platformOverride = p;
}
function isIOS(): boolean {
  return (platformOverride ?? Platform.OS) === "ios";
}

export const UNSUPPORTED_MESSAGE =
  "Live listening isn't available in this preview build. Install the full app build to listen to calls here.";

export const AUDIO_INTERRUPTION_STOP_REASON =
  "Listening paused because another call or phone audio session took over. Press Listen again when you're ready.";

/**
 * The native module uses different codes for the same phone-level event:
 * iOS names AVAudioSession interruptions directly, while Android reports the
 * recorder being taken away as an audio-capture failure.
 */
export function speechErrorIsAudioInterruption(code: string): boolean {
  return code === "interrupted" || code === "audio-capture";
}

/**
 * Plain-English versions of the recognizer's error codes, mirroring the web's
 * micErrorMessage. Returns null for codes that are ordinary life rather than
 * failure ("no-speech" is a quiet moment, "aborted" is us stopping on
 * purpose).
 */
export function speechErrorMessage(code: string): string | null {
  switch (code) {
    case "no-speech":
    case "speech-timeout":
    case "aborted":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return "The microphone is blocked for this app. Open your phone's Settings, allow the microphone (and speech recognition), then press Listen again.";
    case "audio-capture":
      return "The phone couldn't record audio. Close any app that's using the microphone and try again.";
    case "network":
      return "The phone couldn't reach its speech service. Check the connection and try again.";
    case "language-not-supported":
      return "This phone doesn't have a speech pack for your language.";
    case "interrupted":
      return "Something interrupted the microphone (a call screen, Siri, an alarm). Reconnecting…";
    case "busy":
      return "The phone's recognizer is busy. Trying again…";
    default:
      return `The microphone stopped: ${code}.`;
  }
}

/** Is this the kind of failure that can never fix itself? (Web parity.) */
export function speechErrorFatal(code: string): boolean {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
    case "audio-capture":
    case "language-not-supported":
      return true;
    default:
      return false;
  }
}

/**
 * The backoff ladder between reopen attempts. First rung is zero on purpose:
 * the recognizer ending after a natural pause is the common case, and a delay
 * there drops words out of the middle of a sentence.
 */
const RECONNECT_DELAYS_MS = [0, 500, 1_000, 2_000, 4_000, 8_000];
const MAX_RECONNECT_ATTEMPTS = 8;
/** One blip is noise; name the trouble only once it keeps happening. */
const NAME_FAILURE_AFTER_ATTEMPTS = 2;

export function reconnectDelayMs(attempt: number): number {
  const index = Math.min(Math.max(attempt, 0), RECONNECT_DELAYS_MS.length - 1);
  return RECONNECT_DELAYS_MS[index]!;
}

export type CaptureStatus =
  "idle" | "starting" | "listening" | "reconnecting" | "stopped";

export type SpeechPermissionOutcome =
  "not-requested" | "granted" | "denied" | "error";
export type SpeechTranscriptStage =
  | "not-started"
  | "permission-requested"
  | "permission-denied"
  | "recognizer-starting"
  | "listening"
  | "transcript-received"
  | "recognizer-error"
  | "reconnecting"
  | "stopped";
/** Deliberately contains no transcript text or customer fields. */
export type SpeechDiagnostics = {
  platform: "ios" | "android" | "web" | "unknown";
  permission: SpeechPermissionOutcome;
  recognizerError: string | null;
  lastTranscriptStage: SpeechTranscriptStage;
};

export function captureStatusLabel(status: CaptureStatus): string {
  switch (status) {
    case "starting":
      return "Starting…";
    case "listening":
      return "Listening";
    case "reconnecting":
      return "Reconnecting";
    case "stopped":
      return "Stopped";
    case "idle":
      return "Not listening";
  }
}

export type LiveCapture = {
  /** False inside Expo Go / preview builds without the native recognizer. */
  supported: boolean;
  status: CaptureStatus;
  listening: boolean;
  starting: boolean;
  reconnecting: boolean;
  /** A session exists — running or reconnecting. */
  active: boolean;
  /** Everything recognised so far this session. */
  text: string;
  /** The phrase currently being spoken, not yet settled. */
  interim: string;
  error: string | null;
  /** Why the session is no longer running, in plain words. */
  stopReason: string | null;
  /** It ended because something gave out, not because anyone asked. */
  failed: boolean;
  diagnostics: SpeechDiagnostics;
  start: () => void;
  stop: () => void;
  clear: () => void;
};

export function useLiveCapture(): LiveCapture {
  const [supported] = useState(() => loadSpeechModule() != null);
  const [status, setStatus] = useState<CaptureStatus>("idle");
  const [text, setText] = useState("");
  /**
   * Synchronous mirror of `text` for use inside long-lived event listeners
   * where reading React state would give a stale value. Updated atomically
   * inside the setState updater so the two are always in agreement.
   */
  const textRef = useRef("");
  /**
   * Wraps setText so textRef is kept in sync.  Use this everywhere `text` is
   * written; never call the raw `setText` directly after this is defined.
   */
  const setTextSync = useCallback(
    (updater: string | ((prev: string) => string)) => {
      setText((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        textRef.current = next;
        return next;
      });
    },
    [],
  );
  /**
   * Text value at the moment the current native recognizer run opened (i.e.
   * when the "start" event fires).  Used for iOS cumulative-result mode:
   * SFSpeechRecognizer returns the full transcript since the last start(), so
   * we re-apply that cumulative phrase on top of the pre-run words.
   */
  const runBaselineRef = useRef("");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [stopReason, setStopReason] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [diagnostics, setDiagnostics] = useState<SpeechDiagnostics>(() => {
    const os = Platform.OS;
    return {
      platform:
        os === "ios" || os === "android" || os === "web" ? os : "unknown",
      permission: "not-requested",
      recognizerError: null,
      lastTranscriptStage: "not-started",
    };
  });

  // Read inside long-lived listeners, so refs rather than state.
  const wantListeningRef = useRef(false);
  const attemptsRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTransientRef = useRef<string | null>(null);
  const pendingFatalRef = useRef<string | null>(null);
  /**
   * Bumped by anything that countermands a start. Asking for the microphone
   * is asynchronous; without this, a Stop pressed while the permission prompt
   * is still up would be overtaken by its own answer.
   */
  const startTokenRef = useRef(0);
  const subsRef = useRef<SpeechSubscription[]>([]);
  const startRunRef = useRef<() => void>(() => {});
  const startRef = useRef<() => void>(() => {});
  const ownerRef = useRef(Symbol("live-capture-hook"));

  const clearRetry = useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const endSession = useCallback(
    (reason: string | null, didFail: boolean) => {
      const shouldRetireNativeRun = nativeRunOutstanding && !retiringNativeRun;
      startTokenRef.current += 1;
      wantListeningRef.current = false;
      if (pendingStartAfterRetirement?.owner === ownerRef.current) {
        pendingStartAfterRetirement = null;
      }
      clearRetry();
      attemptsRef.current = 0;
      pendingTransientRef.current = null;
      pendingFatalRef.current = null;
      setInterim("");
      setStatus("stopped");
      setStopReason(reason);
      setFailed(didFail);
      setDiagnostics((previous) => ({
        ...previous,
        lastTranscriptStage: didFail ? previous.lastTranscriptStage : "stopped",
      }));
      if (shouldRetireNativeRun) {
        retiringNativeRun = true;
        try {
          loadSpeechModule()?.abort();
        } catch {
          // A failed abort has no terminal event to wait for.
          nativeRunOutstanding = false;
          retiringNativeRun = false;
        }
      }
    },
    [clearRetry],
  );

  /** Recognition ended and the owner still wants to listen: reopen it. */
  const scheduleReopen = useCallback(() => {
    const attempt = attemptsRef.current;
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      const message =
        pendingTransientRef.current ??
        "The microphone kept dropping out and couldn't reconnect. Press Listen to try again.";
      endSession(message, true);
      setError(message);
      return;
    }
    attemptsRef.current = attempt + 1;
    const delay = reconnectDelayMs(attempt);
    if (attemptsRef.current >= NAME_FAILURE_AFTER_ATTEMPTS) {
      setStatus("reconnecting");
      setError(
        pendingTransientRef.current ??
          "The microphone keeps dropping out. Reconnecting…",
      );
    } else if (delay > 0) {
      setStatus("reconnecting");
    }
    setDiagnostics((previous) => ({
      ...previous,
      lastTranscriptStage: "reconnecting",
    }));
    const token = startTokenRef.current;
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      if (token !== startTokenRef.current) return;
      if (!wantListeningRef.current) return;
      startRunRef.current();
    }, delay);
  }, [endSession]);

  // The listeners are installed once for the life of the screen; which
  // session they belong to is decided by wantListeningRef and the token.
  useEffect(() => {
    const mod = loadSpeechModule();
    if (!mod) return;
    const subs: SpeechSubscription[] = [
      mod.addListener("start", () => {
        if (!wantListeningRef.current) return;
        nativeRunOutstanding = true;
        // Record the accumulated words from previous runs so iOS cumulative
        // results can be rebased onto them correctly (see result handler).
        runBaselineRef.current = textRef.current;
        attemptsRef.current = 0;
        pendingTransientRef.current = null;
        setStatus("listening");
        setError(null);
        setStopReason(null);
        setFailed(false);
        setDiagnostics((previous) => ({
          ...previous,
          lastTranscriptStage: "listening",
        }));
      }),
      mod.addListener("result", (payload) => {
        if (!wantListeningRef.current) return;
        const event = payload as SpeechResultEvent;
        // `results` contains alternative hypotheses for this recognition
        // event, not chronological segments. The first entry is the native
        // recognizer's primary transcription; chronological accumulation is
        // handled by the platform-specific final-result logic below.
        const phrase = (event.results?.[0]?.transcript ?? "").trim();
        if (!phrase) return;
        setDiagnostics((previous) => ({
          ...previous,
          lastTranscriptStage: "transcript-received",
        }));
        if (event.isFinal) {
          if (isIOS()) {
            // iOS (SFSpeechRecognizer) with continuous mode sends cumulative
            // transcripts — each final includes everything said since the last
            // start(), not just the new phrase.  Rebase onto the pre-run words
            // so that previous runs' text is not lost or duplicated.
            const base = runBaselineRef.current;
            setTextSync(base ? `${base} ${phrase}` : phrase);
          } else {
            // Android: each isFinal result is an independent segment containing
            // only the new words.  Always append, even when the new segment
            // starts with the same words as the previous one (e.g. the user
            // corrects themselves: "three bedrooms" → "three bedrooms two baths").
            setTextSync((prev) => (prev ? `${prev} ${phrase}` : phrase));
          }
          setInterim("");
        } else {
          setInterim(phrase);
        }
      }),
      mod.addListener("error", (payload) => {
        if (!wantListeningRef.current) return;
        const event = payload as SpeechErrorEvent;
        const message = speechErrorMessage(event.error);
        setDiagnostics((previous) => ({
          ...previous,
          recognizerError: event.error || "unknown",
          lastTranscriptStage: "recognizer-error",
        }));
        if (speechErrorIsAudioInterruption(event.error)) {
          // A phone call, route change, or competing audio session should not
          // make us repeatedly seize the microphone back. End this run as a
          // recoverable pause; a late native "end" is ignored because
          // endSession clears wantListeningRef before aborting.
          endSession(AUDIO_INTERRUPTION_STOP_REASON, false);
          setError(null);
          return;
        }
        if (!message) return;
        if (speechErrorFatal(event.error)) {
          // Ending happens in "end", so there is one way out of a session.
          pendingFatalRef.current = message;
          return;
        }
        pendingTransientRef.current = message;
      }),
      mod.addListener("end", () => {
        if (consumeRetirementEnd) return;
        nativeRunOutstanding = false;
        if (!wantListeningRef.current) return;
        const fatal = pendingFatalRef.current;
        if (fatal) {
          endSession(fatal, true);
          setError(fatal);
          return;
        }
        setInterim("");
        scheduleReopen();
      }),
    ];
    subsRef.current = subs;
    return () => {
      for (const sub of subs) sub.remove();
      subsRef.current = [];
    };
  }, [endSession, scheduleReopen, setTextSync]);

  const startRun = useCallback(() => {
    const mod = loadSpeechModule();
    if (!mod) return;
    try {
      nativeRunOutstanding = true;
      mod.start({
        lang: "en-CA",
        interimResults: true,
        continuous: true,
      });
    } catch {
      nativeRunOutstanding = false;
      // A throw here is nearly always a reopen racing the outgoing run —
      // exactly the case that must recover on its own.
      pendingTransientRef.current =
        "The microphone didn't start. Trying again…";
      scheduleReopen();
    }
  }, [scheduleReopen]);
  startRunRef.current = startRun;

  const start = useCallback(() => {
    const mod = loadSpeechModule();
    if (!mod) {
      setError(UNSUPPORTED_MESSAGE);
      return;
    }
    if (wantListeningRef.current) return;
    if (retiringNativeRun) {
      pendingStartAfterRetirement = {
        owner: ownerRef.current,
        start: () => startRef.current(),
      };
      setStatus("starting");
      setError(null);
      setStopReason(null);
      setFailed(false);
      return;
    }
    const token = ++startTokenRef.current;
    wantListeningRef.current = true;
    attemptsRef.current = 0;
    pendingTransientRef.current = null;
    pendingFatalRef.current = null;
    setStatus("starting");
    setError(null);
    setStopReason(null);
    setFailed(false);
    setDiagnostics((previous) => ({
      ...previous,
      permission: "not-requested",
      recognizerError: null,
      lastTranscriptStage: "permission-requested",
    }));
    void (async () => {
      let granted = false;
      let permission: SpeechPermissionOutcome = "denied";
      try {
        const answer = await mod.requestPermissionsAsync();
        granted = answer.granted === true;
        permission = granted ? "granted" : "denied";
      } catch {
        granted = false;
        permission = "error";
      }
      // A Stop (or entitlement loss) while the prompt was up wins.
      if (token !== startTokenRef.current || !wantListeningRef.current) return;
      setDiagnostics((previous) => ({ ...previous, permission }));
      if (!granted) {
        setDiagnostics((previous) => ({
          ...previous,
          lastTranscriptStage: "permission-denied",
        }));
        const message = speechErrorMessage("not-allowed")!;
        endSession(message, true);
        setError(message);
        return;
      }
      setDiagnostics((previous) => ({
        ...previous,
        lastTranscriptStage: "recognizer-starting",
      }));
      startRun();
    })();
  }, [endSession, startRun]);
  startRef.current = start;

  const stop = useCallback(() => {
    if (!wantListeningRef.current && status === "idle") return;
    endSession("You stopped listening.", false);
  }, [endSession, status]);

  const clear = useCallback(() => {
    setTextSync("");
    setInterim("");
    // On iOS the native run is cumulative: every future isFinal result would
    // include the cleared words unless we start a fresh run. Aborting here
    // triggers the "end" listener → scheduleReopen at delay 0, giving a new
    // run whose "start" event captures an empty runBaselineRef.
    if (isIOS() && wantListeningRef.current) {
      attemptsRef.current = 0; // ensure the immediate-reopen rung of the ladder
      try {
        loadSpeechModule()?.abort();
      } catch {
        // abort() on an already-ended run is harmless; scheduleReopen handles it.
      }
    }
  }, [setTextSync]);

  // Leaving the screen must not leave the microphone on.
  useEffect(() => {
    return () => {
      if (pendingStartAfterRetirement?.owner === ownerRef.current) {
        pendingStartAfterRetirement = null;
      }
      if (wantListeningRef.current) {
        startTokenRef.current += 1;
        wantListeningRef.current = false;
      }
      if (nativeRunOutstanding && !retiringNativeRun) {
        retiringNativeRun = true;
        try {
          loadSpeechModule()?.abort();
        } catch {
          // No terminal event will arrive, so do not strand the next screen's
          // Listen request behind a retirement that cannot finish.
          nativeRunOutstanding = false;
          retiringNativeRun = false;
        }
      }
      if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
    };
  }, []);

  // Microphone capture is foreground-only. Backgrounding must end the session
  // rather than silently resuming when the owner returns: this also invalidates
  // permission/start continuations and any delayed reconnect.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" || !wantListeningRef.current) return;
      endSession(
        "Listening stopped because the app went into the background.",
        false,
      );
    });
    return () => sub.remove();
  }, [endSession]);

  const listening = status === "listening";
  const starting = status === "starting";
  const reconnecting = status === "reconnecting";
  return {
    supported,
    status,
    listening,
    starting,
    reconnecting,
    active: listening || starting || reconnecting,
    text,
    interim,
    error,
    stopReason,
    failed,
    diagnostics,
    start,
    stop,
    clear,
  };
}
