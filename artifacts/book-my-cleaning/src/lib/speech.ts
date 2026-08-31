import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Live speech-to-text from the dispatcher's own microphone.
 *
 * This exists because Quo hands over a transcript only *after* the call ends,
 * and the person taking the booking needs the words while the customer is
 * still talking. So the dispatcher puts the call on speaker and the browser
 * listens to the room.
 *
 * Built on the browser's own recognition, which means:
 *  - no audio leaves the machine through us, and nothing is stored;
 *  - it is Chrome/Edge only, so `supported` is checked before anything is
 *    offered — a Safari user should see the after-the-call path instead of a
 *    button that does nothing;
 *  - recognition stops itself constantly — after a pause, after a minute or
 *    so of talking, whenever Chrome's speech service hiccups. A session that
 *    lasts a whole phone call is therefore *many* recognition objects in a
 *    row, reopened underneath the dispatcher without them noticing.
 *
 * Two rules come out of that and they are the whole design:
 *
 *  1. While the dispatcher still wants to listen, an end is something to
 *     reopen — not something to report. Only a cause that can never recover
 *     (a refused microphone, no input device, no speech pack) ends the
 *     session, and only that clears the intent to listen. Everything else
 *     gets a short backoff and another go, keeping every word already heard.
 *  2. Silence is never left unexplained. The microphone light on with no
 *     words has several unrelated causes (a denied permission, Chrome unable
 *     to reach its speech service, the wrong input device, a caller who isn't
 *     on speaker), so each one is proved and named.
 */

/**
 * Minimal shape of the vendor-prefixed API. Typed here rather than pulled from
 * lib.dom because it is still not in the standard DOM types.
 */
type SpeechRecognitionAlternative = { transcript: string };
type SpeechRecognitionResult = {
  isFinal: boolean;
  0: SpeechRecognitionAlternative;
};
type SpeechRecognitionEvent = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResult;
  };
};
type SpeechRecognitionErrorEvent = { error: string };
type SpeechRecognitionInstance = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: (() => void) | null;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

function recognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Plain-English version of the browser's error codes.
 *
 * Returns null for the codes that are ordinary life rather than failure:
 * "no-speech" is a quiet moment and "aborted" is us stopping on purpose.
 * Anything else has to be shown, because a silent transcript box with no
 * explanation is the exact thing that makes this feature look broken.
 */
export function micErrorMessage(code: string): string | null {
  switch (code) {
    case "no-speech":
    case "aborted":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return "Your browser blocked the microphone. Click the padlock (or camera icon) in the address bar, allow the microphone for this site, then press Start listening again.";
    case "audio-capture":
      return "No microphone was found. Plug one in or pick the right input in your computer's sound settings, then press Start listening again.";
    case "network":
      return "Chrome couldn't reach its speech service, so it can't turn the audio into words. Check the internet connection and try again.";
    case "language-not-supported":
      return "This browser doesn't have a speech pack for your language.";
    default:
      return `The microphone stopped: ${code}.`;
  }
}

/**
 * Is this the kind of failure that can never fix itself?
 *
 * The distinction is the difference between a session that survives a phone
 * call and one that dies in the first ten seconds. A refused microphone will
 * still be refused on the next attempt, so retrying it is a lie. Chrome's
 * speech service blipping — by far the most common `network` error — clears
 * up on its own within a second or two, and reopening is exactly right.
 */
export function micErrorFatal(code: string): boolean {
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

/** Has the person already allowed the microphone on this site? */
export async function micAlreadyAllowed(): Promise<boolean> {
  if (typeof navigator === "undefined") return false;
  const permissions = navigator.permissions as
    (Permissions & { query?: Permissions["query"] }) | undefined;
  if (!permissions?.query) return false;
  try {
    // The microphone name isn't in every lib.dom version yet.
    const status = await permissions.query({
      name: "microphone" as PermissionName,
    });
    return status.state === "granted";
  } catch {
    // Firefox throws on unknown names. Unknown means "don't assume yes".
    return false;
  }
}

/**
 * Ask for the microphone and let go of it again.
 *
 * Recognition opens its own stream, so this is only here to turn a silent
 * refusal into a message — and, when the answer is yes, to make the *next*
 * start silent, which is what lets a call start capturing on its own.
 */
async function proveMicrophone(): Promise<string | null> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) return null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Release it immediately or the tab holds two microphone streams open and
    // the recording indicator stays lit after listening stops.
    for (const track of stream.getTracks()) track.stop();
    return null;
  } catch (err) {
    const name = (err as { name?: string }).name ?? "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      return micErrorMessage("not-allowed");
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      return micErrorMessage("audio-capture");
    }
    return null;
  }
}

/**
 * How long the microphone can be on with nothing recognised before we say so.
 * Long enough to cover a greeting and a pause; short enough that a dispatcher
 * finds out before the call is over.
 */
const QUIET_AFTER_MS = 12_000;

/**
 * How long a session with nothing heard at all may stay open before it
 * retires itself.
 *
 * Nothing else switches the microphone off any more — not a hangup, not an
 * error — so this is the one backstop against a forgotten tab holding the
 * recording light on all afternoon. Ten minutes of complete silence is far
 * longer than any gap in a real conversation, and the retirement says so out
 * loud rather than going quiet.
 */
const RETIRE_AFTER_SILENT_MS = 10 * 60_000;
const SILENCE_CHECK_MS = 30_000;

/**
 * The backoff ladder between reopen attempts, in milliseconds.
 *
 * The first rung is zero on purpose: recognition ending after a natural pause
 * is the common case by a mile, and putting a delay there would drop words
 * out of the middle of a sentence. The ladder only starts costing time once
 * attempts are failing back to back.
 */
const RECONNECT_DELAYS_MS = [0, 500, 1_000, 2_000, 4_000, 8_000];

/** Consecutive failed reopens before the session gives up for good. */
const MAX_RECONNECT_ATTEMPTS = 8;

/**
 * How many consecutive failures before the reason is put on screen. One blip
 * is noise; naming it would train the dispatcher to ignore the message that
 * matters.
 */
const NAME_FAILURE_AFTER_ATTEMPTS = 2;

export function reconnectDelayMs(attempt: number): number {
  const index = Math.min(Math.max(attempt, 0), RECONNECT_DELAYS_MS.length - 1);
  return RECONNECT_DELAYS_MS[index]!;
}

/**
 * Where the session is right now. The dispatcher reads exactly one of these
 * off the screen, so they are named the way they'd say them out loud.
 */
export type CaptureStatus =
  "idle" | "starting" | "listening" | "reconnecting" | "paused" | "stopped";

/** The word for the current state, for the status line. */
export function captureStatusLabel(status: CaptureStatus): string {
  switch (status) {
    case "starting":
      return "Starting…";
    case "listening":
      return "Listening";
    case "reconnecting":
      return "Reconnecting";
    case "paused":
      return "Paused";
    case "stopped":
      return "Stopped";
    case "idle":
      return "Not listening";
  }
}

/** "4:07" — how long this session has been listening. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export type LiveTranscript = {
  supported: boolean;
  /** Which of Listening / Paused / Reconnecting / Stopped it is in. */
  status: CaptureStatus;
  listening: boolean;
  /** Permission is being asked for / recognition is spinning up. */
  starting: boolean;
  paused: boolean;
  /** Recognition dropped and is being reopened; the words are being kept. */
  reconnecting: boolean;
  /** A session exists — running, reconnecting or deliberately paused. */
  active: boolean;
  /** Everything recognised so far this session. */
  text: string;
  /** The phrase currently being spoken, not yet settled. */
  interim: string;
  /** Set when something failed in a way worth naming on screen. */
  error: string | null;
  /** Why the session is no longer running, in plain words. */
  stopReason: string | null;
  /** It ended because something gave out, not because anyone asked. */
  failed: boolean;
  /** Listening, but nothing has been heard for a worrying while. */
  quiet: boolean;
  /** How long this session has been listening, pauses excluded. */
  elapsedMs: number;
  start: () => void;
  stop: () => void;
  /** Stop capturing but keep every word; Resume carries on from here. */
  pause: () => void;
  resume: () => void;
  /** Throw the transcript away and start a fresh one, on the spot. */
  restart: () => void;
  clear: () => void;
};

export function useLiveTranscript(): LiveTranscript {
  const [supported] = useState(() => recognitionConstructor() != null);
  const [status, setStatus] = useState<CaptureStatus>("idle");
  const [text, setText] = useState("");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [stopReason, setStopReason] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [quiet, setQuiet] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  // Read inside `onend`, which is why it is a ref: the handler is installed
  // once and would otherwise close over whatever the state was at the time.
  const wantListeningRef = useRef(false);
  const heardAnythingRef = useRef(false);
  const lastHeardRef = useRef(0);
  /** Consecutive reopens that never reached `onstart`. */
  const attemptsRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The most recent transient reason, held back until it keeps happening. */
  const pendingTransientRef = useRef<string | null>(null);
  /** A cause that can never recover; `onend` turns it into the end. */
  const pendingFatalRef = useRef<string | null>(null);
  /**
   * Bumped by anything that countermands a start. Asking for the microphone
   * is asynchronous, so without this a Stop (or a Pause) pressed while the
   * permission check is still in flight would be overtaken by its own answer
   * — the microphone would come on *because* the dispatcher switched it off.
   */
  const startTokenRef = useRef(0);
  /**
   * Which recognition object the handlers belong to. `stop()` is asynchronous
   * in a real browser, so a Restart leaves the outgoing instance alive for a
   * moment; without this its late `onend` would reopen a second session on
   * top of the new one.
   */
  const sessionSeqRef = useRef(0);
  /** Wall-clock bookkeeping for the elapsed timer, pauses excluded. */
  const accumulatedRef = useRef(0);
  const sinceRef = useRef<number | null>(null);

  const clearRetry = useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const freezeClock = useCallback(() => {
    if (sinceRef.current !== null) {
      accumulatedRef.current += Date.now() - sinceRef.current;
      sinceRef.current = null;
    }
    setElapsedMs(accumulatedRef.current);
  }, []);

  /** Let go of the current recognition object and disown its handlers. */
  const teardown = useCallback(() => {
    startTokenRef.current += 1;
    sessionSeqRef.current += 1;
    wantListeningRef.current = false;
    clearRetry();
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    recognition?.stop();
  }, [clearRetry]);

  const endSession = useCallback(
    (next: CaptureStatus, reason: string | null, didFail: boolean) => {
      teardown();
      attemptsRef.current = 0;
      pendingTransientRef.current = null;
      pendingFatalRef.current = null;
      freezeClock();
      setInterim("");
      setQuiet(false);
      setStatus(next);
      setStopReason(reason);
      setFailed(didFail);
    },
    [teardown, freezeClock],
  );

  const openRef = useRef<() => void>(() => {});

  /**
   * Recognition ended and the dispatcher still wants to listen. Reopen it.
   *
   * This is the heart of the fix: an end is not news. Chrome ends the session
   * after every pause and whenever its speech service blips, and the old code
   * treated the second of those as the end of the world.
   */
  const scheduleReopen = useCallback(() => {
    const attempt = attemptsRef.current;
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      const message =
        pendingTransientRef.current ??
        "The microphone kept dropping out and couldn't reconnect. Press Start listening to try again.";
      endSession("stopped", message, true);
      setError(message);
      return;
    }
    attemptsRef.current = attempt + 1;
    const delay = reconnectDelayMs(attempt);
    if (attemptsRef.current >= NAME_FAILURE_AFTER_ATTEMPTS) {
      // It keeps failing, so now it's worth saying.
      setStatus("reconnecting");
      setError(
        pendingTransientRef.current ??
          "The microphone keeps dropping out. Reconnecting…",
      );
    } else if (delay > 0) {
      setStatus("reconnecting");
    }
    const token = startTokenRef.current;
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      if (token !== startTokenRef.current) return;
      if (!wantListeningRef.current) return;
      openRef.current();
    }, delay);
  }, [endSession]);

  /**
   * Open a recognition session. Split from `start` so reopening — after a
   * natural pause or a blip — never asks for permission all over again.
   */
  const openSession = useCallback(() => {
    const Ctor = recognitionConstructor();
    if (!Ctor) return;
    if (recognitionRef.current) return;

    const recognition = new Ctor();
    const mine = ++sessionSeqRef.current;
    const current = () => mine === sessionSeqRef.current;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-CA";

    recognition.onstart = () => {
      if (!current()) return;
      // The real signal that the microphone is open, rather than our hope
      // that it would be: `start()` returning simply means it was accepted.
      attemptsRef.current = 0;
      pendingTransientRef.current = null;
      if (sinceRef.current === null) sinceRef.current = Date.now();
      lastHeardRef.current = Date.now();
      setStatus("listening");
      setError(null);
      setStopReason(null);
      setFailed(false);
    };

    recognition.onresult = (event) => {
      if (!current()) return;
      heardAnythingRef.current = true;
      lastHeardRef.current = Date.now();
      setQuiet(false);
      let settled = "";
      let pending = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]!;
        const phrase = result[0].transcript;
        if (result.isFinal) settled += phrase;
        else pending += phrase;
      }
      if (settled) {
        setText((prev) =>
          prev ? `${prev} ${settled.trim()}` : settled.trim(),
        );
      }
      setInterim(pending.trim());
    };

    recognition.onerror = (event) => {
      if (!current()) return;
      const message = micErrorMessage(event.error);
      // "no-speech" and "aborted" are ordinary life; `onend` handles them.
      if (!message) return;
      if (micErrorFatal(event.error)) {
        // Ending happens in `onend`, so there is one way out of a session.
        pendingFatalRef.current = message;
        return;
      }
      pendingTransientRef.current = message;
    };

    recognition.onend = () => {
      if (!current()) return;
      recognitionRef.current = null;
      const fatal = pendingFatalRef.current;
      if (fatal) {
        endSession("stopped", fatal, true);
        setError(fatal);
        return;
      }
      // Reopen only while the dispatcher still has it switched on, so Stop
      // and Pause actually stop.
      if (!wantListeningRef.current) return;
      setInterim("");
      scheduleReopen();
    };

    recognitionRef.current = recognition;
    wantListeningRef.current = true;
    try {
      recognition.start();
    } catch {
      /**
       * Dropping the reference matters most: holding a dead instance made
       * every later attempt bail out at the guard above, so the microphone
       * never came on again. A throw here is nearly always a reopen racing
       * the outgoing session, which is exactly the case that must recover on
       * its own — so it goes on the backoff ladder like any other blip.
       */
      recognitionRef.current = null;
      sessionSeqRef.current += 1;
      pendingTransientRef.current =
        "The microphone didn't start. Trying again…";
      if (wantListeningRef.current) scheduleReopen();
    }
  }, [endSession, scheduleReopen]);

  openRef.current = openSession;

  /**
   * Everything that opens a session goes through here. `keepClock` is the
   * only difference between Resume (carry on counting) and Start / Restart
   * (a fresh session, from zero).
   */
  const beginSession = useCallback(
    (keepClock: boolean) => {
      if (!recognitionConstructor()) return;
      teardown();
      attemptsRef.current = 0;
      pendingTransientRef.current = null;
      pendingFatalRef.current = null;
      if (!keepClock) {
        accumulatedRef.current = 0;
        setElapsedMs(0);
      }
      sinceRef.current = null;
      setError(null);
      setStopReason(null);
      setFailed(false);
      setQuiet(false);
      heardAnythingRef.current = false;
      lastHeardRef.current = Date.now();
      setStatus("starting");

      const token = ++startTokenRef.current;
      void proveMicrophone()
        .then((problem) => {
          // Stopped, paused, restarted or unmounted while we waited.
          if (token !== startTokenRef.current) return;
          if (problem) {
            endSession("stopped", problem, true);
            setError(problem);
            return;
          }
          openSession();
        })
        .catch(() => {
          /**
           * proveMicrophone catches everything it expects, so landing here
           * means something genuinely strange broke on the way to the
           * microphone. The one unforgivable outcome is a spinner that never
           * stops and a Start button that never works again — reset the state
           * so the next press starts clean, and say something.
           */
          if (token !== startTokenRef.current) return;
          const message =
            "Something went wrong while checking the microphone. Press Start listening to try again.";
          endSession("stopped", message, true);
          setError(message);
        });
    },
    [endSession, openSession, teardown],
  );

  const start = useCallback(() => beginSession(false), [beginSession]);
  const resume = useCallback(() => beginSession(true), [beginSession]);

  const stop = useCallback(() => {
    endSession("stopped", "You stopped listening.", false);
    setError(null);
  }, [endSession]);

  const pause = useCallback(() => {
    endSession("paused", null, false);
    setError(null);
  }, [endSession]);

  const clear = useCallback(() => {
    setText("");
    setInterim("");
  }, []);

  const restart = useCallback(() => {
    setText("");
    setInterim("");
    beginSession(false);
  }, [beginSession]);

  /**
   * The microphone is on and nothing has come through. Say so rather than
   * leaving an empty box that looks identical to a broken feature — usually
   * the caller isn't on speaker, or Chrome is listening to the wrong input.
   */
  useEffect(() => {
    if (status !== "listening") return;
    heardAnythingRef.current = false;
    const timer = setTimeout(() => {
      if (!heardAnythingRef.current) setQuiet(true);
    }, QUIET_AFTER_MS);
    return () => clearTimeout(timer);
  }, [status]);

  /** The elapsed timer on the status line. */
  useEffect(() => {
    if (status !== "listening" && status !== "reconnecting") return;
    const tick = () =>
      setElapsedMs(
        accumulatedRef.current +
          (sinceRef.current === null ? 0 : Date.now() - sinceRef.current),
      );
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [status]);

  /**
   * Nothing switches the microphone off on its own any more, so a session
   * that everyone walked away from needs one backstop — and it announces
   * itself rather than dying quietly.
   */
  useEffect(() => {
    if (status !== "listening" && status !== "reconnecting") return;
    const timer = setInterval(() => {
      if (Date.now() - lastHeardRef.current < RETIRE_AFTER_SILENT_MS) return;
      const message =
        "Nothing was heard for ten minutes, so the microphone switched itself off. Press Start listening when you need it again.";
      endSession("stopped", message, true);
      setError(message);
    }, SILENCE_CHECK_MS);
    return () => clearInterval(timer);
  }, [status, endSession]);

  // Leaving the page must release the microphone, or the browser keeps the
  // recording indicator lit long after the dispatcher has moved on.
  useEffect(() => {
    return () => {
      startTokenRef.current += 1;
      sessionSeqRef.current += 1;
      wantListeningRef.current = false;
      if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  return {
    supported,
    status,
    listening: status === "listening",
    starting: status === "starting",
    paused: status === "paused",
    reconnecting: status === "reconnecting",
    active:
      status === "listening" ||
      status === "starting" ||
      status === "reconnecting" ||
      status === "paused",
    text,
    interim,
    error,
    stopReason,
    failed,
    quiet,
    elapsedMs,
    start,
    stop,
    pause,
    resume,
    restart,
    clear,
  };
}
