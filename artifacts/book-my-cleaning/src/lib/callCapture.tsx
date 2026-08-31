import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  micAlreadyAllowed,
  useLiveTranscript,
  type LiveTranscript,
} from "@/lib/speech";

/**
 * One live-transcription session for the whole app.
 *
 * It used to live on the booking desk, which meant the words only started
 * being caught once the dispatcher had navigated there, chosen a tab and
 * pressed a button — by which point the customer had already said their name
 * and half their address. Worse, walking away from the page threw the
 * transcript away.
 *
 * So the session lives here instead, above the router: a call starts, the
 * microphone starts, and whatever has been heard is already waiting in the
 * form whenever the dispatcher gets to it.
 *
 * No audio is ever recorded or kept — this is the browser's own recognition,
 * and the transcript dies with the tab. The recognized *words* do make one
 * trip to the company's own API when a draft is scanned; copy shown to the
 * dispatcher must say that honestly rather than claim nothing leaves the
 * computer.
 */

const AUTO_LISTEN_KEY = "bmc.callCapture.autoListen";
const SOUND_KEY = "bmc.callCapture.sound";
const MIC_MODE_KEY = "bmc.callCapture.micMode";

/**
 * ScrubbyBuilder answers calls on the phone and uses the desktop app to work
 * from the resulting call details. A browser microphone must never start on
 * its own there, even if this browser has an older saved preference.
 */
export function autoListenAvailableForCompany(companyName: string): boolean {
  const normalized = companyName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized !== "scrubbybuilder";
}

/**
 * How the dispatcher is holding the call, which decides what the computer's
 * microphone can possibly hear.
 *
 * "speaker": the call is on speakerphone, both sides are in the air, and the
 * transcript is the whole conversation.
 *
 * "earbuds": the customer's voice goes straight into the dispatcher's ears
 * and no microphone anywhere can hear it — so the transcript is only the
 * dispatcher's own side, and the coaching changes from "put them on speaker"
 * to "repeat the details back out loud".
 */
export type MicMode = "speaker" | "earbuds";

function readMicMode(): MicMode {
  if (typeof localStorage === "undefined") return "speaker";
  try {
    return localStorage.getItem(MIC_MODE_KEY) === "earbuds"
      ? "earbuds"
      : "speaker";
  } catch {
    return "speaker";
  }
}

function readFlag(key: string, fallback: boolean): boolean {
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // A locked-down browser refusing storage is not worth an error; the
    // preference just goes back to its default next time.
  }
}

function writeMicMode(mode: MicMode): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(MIC_MODE_KEY, mode);
  } catch {
    // Same as the flags: no storage just means the default next time.
  }
}

/**
 * What to say while the microphone is listening and words are arriving.
 * On speaker the form writes itself; on earbuds the dispatcher *is* the
 * microphone, so the line has to teach the repeat-back habit instead.
 */
export function listeningHint(mode: MicMode): string {
  return mode === "earbuds"
    ? "Only your side can be heard — repeat details back (“So that's 123 Main Street… two bedrooms…”) and the form fills in from your words."
    : "The form fills itself in whenever they pause.";
}

/**
 * What to say when the microphone is on but nothing has come through for a
 * while.
 *
 * On speaker that means something is genuinely wrong — wrong input device,
 * or the call isn't on speaker at all. On earbuds a long silence is just the
 * customer talking (inaudibly, by definition), so nagging about speakerphone
 * would be wrong twice over: it isn't a fault, and speaker is exactly what
 * the dispatcher chose not to use.
 */
export function quietMicMessage(mode: MicMode): string {
  return mode === "earbuds"
    ? "All quiet — normal on earbuds while the customer is talking. When they give a detail, say it back out loud (“So that's two bedrooms…”) and it lands in the form. If you have been talking and nothing shows up, check Chrome is listening to the right microphone (the padlock in the address bar)."
    : "The microphone is on but nothing is coming through. Put the caller on speaker, and check Chrome is listening to the right microphone (the padlock in the address bar).";
}

/**
 * The paragraph on the booking desk that teaches the chosen mode.
 *
 * One privacy sentence for both, and it has to be the honest one: no audio
 * is recorded anywhere, but the transcribed words do go to the company's own
 * booking server for a moment — that is what fills the boxes. "The words
 * never leave this computer" was a lie by one hop and must not come back.
 */
export function captureGuidance(mode: MicMode): string {
  const privacy =
    "No audio is recorded or kept: the words go to your own booking server just long enough to fill the boxes, and aren't stored.";
  return mode === "earbuds"
    ? `Earbuds in: only you can be heard — the customer's voice never reaches this computer. Repeat each detail back as they give it (“So that's 123 Main Street… two bedrooms, one bathroom…”) and the form fills in from your side of the call. ${privacy}`
    : `Put the caller on speaker. The form fills itself in as they talk — name, phone, address, service, bedrooms, bathrooms and the day they asked for. ${privacy}`;
}

/**
 * Every reason capture can decline to start, named. "It just didn't start"
 * is the one bug report an owner can't act on — each of these carries its
 * own remedy, and the UI shows it wherever the owner happens to be.
 */
export type CaptureDecline =
  | "auto-listen-off"
  | "needs-permission"
  | "busy-other-call"
  | "unsupported"
  | "start-failed";

export function declineMessage(reason: CaptureDecline): string {
  switch (reason) {
    case "auto-listen-off":
      return "A call came in but auto-listen is switched off, so nothing was captured. Turn “Start listening on its own” back on (on the booking desk), or press Start listening for this call.";
    case "needs-permission":
      return "A call is in — allow the microphone once and every call after this one starts typing itself into the booking form.";
    case "busy-other-call":
      return "Another call is already being captured, so this one gets the pop-up but not the microphone. Stop the current capture first if this is the call that matters.";
    case "unsupported":
      return "This browser can't listen to calls. Use Chrome or Edge for live capture, or fill the form in from the write-up after the call ends.";
    case "start-failed":
      return "The microphone didn't start. Press Start listening to try again.";
  }
}

export type CallCapture = {
  transcript: LiveTranscript;
  /** Start listening by itself when the phone rings. */
  autoListen: boolean;
  /** Whether this company permits automatic microphone starts at all. */
  autoListenAvailable: boolean;
  setAutoListen: (on: boolean) => void;
  /** Make a sound when the phone rings. */
  soundOn: boolean;
  setSoundOn: (on: boolean) => void;
  /** Speakerphone or earbuds — what the microphone can hope to hear. */
  micMode: MicMode;
  setMicMode: (mode: MicMode) => void;
  /** The call this session is following, if it started on its own. */
  capturingCallId: number | null;
  /**
   * The call list says the call being followed is over. A note beside the
   * transcript — never a reason to switch the microphone off, because Quo
   * moves a call off `in_progress` while the two people are still talking.
   */
  callLooksOver: boolean;
  /** The call watcher reporting what it sees. */
  noteCallOver: (over: boolean) => void;
  /**
   * True when a call came in, auto-listen is on, and the browser has never
   * been given the microphone — so nothing started and the dispatcher needs
   * to press the button once.
   */
  needsPermission: boolean;
  /** Why the last start didn't happen, if it didn't. Null when all is well. */
  declined: CaptureDecline | null;
  /** Something outside the provider declined a start (e.g. the takeover guard). */
  noteDecline: (reason: CaptureDecline) => void;
  /** The owner has read the reason; put it away. */
  clearDecline: () => void;
  /** A call started: begin capturing if we're allowed to without asking. */
  startForCall: (callId: number) => void;
  /** The dispatcher pressed the button. Asking is fine here. */
  startManually: (callId?: number | null) => void;
  /** The dispatcher stopped it. Keeps the words. */
  endCapture: () => void;
  /** Account changed: stop and discard all owner-specific capture state. */
  resetCapture: () => void;
  /** Stop capturing, keep every word, stay on this call. */
  pauseCapture: () => void;
  /** Carry on appending to the same transcript. */
  resumeCapture: () => void;
  /** Throw the transcript away and start a fresh one, on the spot. */
  restartCapture: () => void;
};

const Context = createContext<CallCapture | null>(null);

export function CallCaptureProvider({
  children,
  accountId,
  autoListenAvailable = true,
}: {
  children: React.ReactNode;
  /**
   * The authenticated identity that owns this session. Leave undefined for
   * standalone embeds/tests that do not have an auth provider.
   */
  accountId?: string | null;
  /**
   * Some companies answer on a physical phone and use the browser only for
   * booking work. Those companies can still start the microphone manually,
   * but never automatically when a call arrives.
   */
  autoListenAvailable?: boolean;
}) {
  const transcript = useLiveTranscript();
  const [autoListenPreference, setAutoListenState] = useState(() =>
    readFlag(AUTO_LISTEN_KEY, true),
  );
  const autoListen = autoListenAvailable && autoListenPreference;
  const [soundOn, setSoundOnState] = useState(() => readFlag(SOUND_KEY, true));
  const [micMode, setMicModeState] = useState<MicMode>(readMicMode);
  const [capturingCallId, setCapturingCallId] = useState<number | null>(null);
  const [needsPermission, setNeedsPermission] = useState(false);
  const [declined, setDeclined] = useState<CaptureDecline | null>(null);
  const [callLooksOver, setCallLooksOver] = useState(false);

  const setAutoListen = useCallback(
    (on: boolean) => {
      if (!autoListenAvailable) return;
      setAutoListenState(on);
      writeFlag(AUTO_LISTEN_KEY, on);
      if (on) {
        setNeedsPermission(false);
        setDeclined((prev) => (prev === "auto-listen-off" ? null : prev));
      }
    },
    [autoListenAvailable],
  );

  const setSoundOn = useCallback((on: boolean) => {
    setSoundOnState(on);
    writeFlag(SOUND_KEY, on);
  }, []);

  const setMicMode = useCallback((mode: MicMode) => {
    setMicModeState(mode);
    writeMicMode(mode);
  }, []);

  const { start, stop, pause, resume, restart, listening, supported } =
    transcript;
  // The handlers below are installed once per call, so they read live state
  // through refs rather than closing over a stale copy.
  const listeningRef = useRef(listening);
  listeningRef.current = listening;
  const autoListenRef = useRef(autoListen);
  autoListenRef.current = autoListen;
  const autoListenAvailableRef = useRef(autoListenAvailable);
  autoListenAvailableRef.current = autoListenAvailable;
  /**
   * Bumped by anything that countermands a pending automatic start. The
   * permission check is asynchronous, so a call that ends — or a dispatcher
   * who presses Stop — while it is in flight must not be overruled by its own
   * answer arriving a moment later.
   */
  const intentRef = useRef(0);
  /**
   * `undefined` is the initial/loading sentinel. A resolved identity changing
   * to another identity — including signed out (`null`) — must not inherit the
   * previous owner's microphone, words or call claim.
   */
  const previousAccountIdRef = useRef<string | null | undefined>(undefined);

  const startForCall = useCallback(
    (callId: number) => {
      if (!supported) {
        setDeclined("unsupported");
        return;
      }
      // This is an office policy, not a failed start. Stay quiet so the phone
      // workflow can continue without a misleading "turn it back on" notice.
      if (!autoListenAvailableRef.current) return;
      if (!autoListenRef.current) {
        setDeclined("auto-listen-off");
        return;
      }
      if (listeningRef.current) {
        setCapturingCallId(callId);
        return;
      }
      /**
       * Only start on our own initiative if the microphone has already been
       * granted. Springing a permission prompt on someone who is mid-call and
       * looking at another page is how a browser ends up blocking the site
       * for good — and a blocked site can never listen again.
       */
      const token = ++intentRef.current;
      /**
       * Claim the call *before* the asynchronous permission check, not after.
       * The hangup watcher can only cancel a start it can see: if the call
       * ends while the check is still in flight, `endCapture` bumps the
       * intent token and the late answer below is dropped. Claiming late
       * left a window where a dead call's permission answer switched the
       * microphone on with nothing watching it.
       */
      setCapturingCallId(callId);
      void micAlreadyAllowed()
        .then((allowed) => {
          if (token !== intentRef.current) return;
          if (!allowed) {
            setNeedsPermission(true);
            setDeclined("needs-permission");
            // Nothing started, so nothing is following the call.
            setCapturingCallId(null);
            return;
          }
          setNeedsPermission(false);
          setDeclined(null);
          start();
        })
        .catch(() => {
          /**
           * The permission check itself fell over. Whatever the cause, the
           * session must not be left half-claimed with a spinner that never
           * resolves: release the call, name the failure, and let the next
           * press start clean.
           */
          if (token !== intentRef.current) return;
          setNeedsPermission(false);
          setCapturingCallId(null);
          setDeclined("start-failed");
        });
    },
    [start, supported],
  );

  const startManually = useCallback(
    (callId?: number | null) => {
      intentRef.current += 1;
      setNeedsPermission(false);
      if (!supported) {
        // start() would silently do nothing; say why instead.
        setDeclined("unsupported");
        return;
      }
      setDeclined(null);
      if (callId != null) setCapturingCallId(callId);
      start();
    },
    [start, supported],
  );

  const endCapture = useCallback(() => {
    intentRef.current += 1;
    setCapturingCallId(null);
    setDeclined(null);
    setCallLooksOver(false);
    stop();
  }, [stop]);

  const resetCapture = useCallback(() => {
    intentRef.current += 1;
    setCapturingCallId(null);
    setNeedsPermission(false);
    setDeclined(null);
    setCallLooksOver(false);
    stop();
    transcript.clear();
  }, [stop, transcript.clear]);

  useEffect(() => {
    const previousAccountId = previousAccountIdRef.current;
    if (previousAccountId !== undefined && previousAccountId !== accountId) {
      resetCapture();
    }
    previousAccountIdRef.current = accountId;
  }, [accountId, resetCapture]);

  /**
   * Pause keeps the claim: the dispatcher is still on this call, they just
   * don't want the next thing said typed into the form. Bumping the intent
   * token matters as much here as it does for Stop — a pause pressed while a
   * permission check is still in flight must not be overtaken by its answer.
   */
  const pauseCapture = useCallback(() => {
    intentRef.current += 1;
    setDeclined(null);
    pause();
  }, [pause]);

  const resumeCapture = useCallback(() => {
    intentRef.current += 1;
    setDeclined(null);
    resume();
  }, [resume]);

  const restartCapture = useCallback(() => {
    intentRef.current += 1;
    setDeclined(null);
    restart();
  }, [restart]);

  const noteCallOver = useCallback((over: boolean) => {
    setCallLooksOver((prev) => (prev === over ? prev : over));
  }, []);

  const noteDecline = useCallback(
    (reason: CaptureDecline) => setDeclined(reason),
    [],
  );
  const clearDecline = useCallback(() => setDeclined(null), []);

  /**
   * The session gave out for good — a denied or missing microphone, no speech
   * pack, or reconnecting that ran out of attempts. Whatever claim it made
   * must be released: a phantom claim is a "Live call" badge on a microphone
   * that is off, and it blocks the takeover guard for the next call.
   *
   * Only a *permanently* fatal end reaches this. A blip that is being
   * reconnected keeps the claim, keeps the words, and says nothing here —
   * releasing the call on the first `network` error is what used to make one
   * hiccup the end of the session.
   */
  const { failed: transcriptFailed } = transcript;
  const capturingRef = useRef(capturingCallId);
  capturingRef.current = capturingCallId;
  useEffect(() => {
    if (!transcriptFailed) return;
    intentRef.current += 1;
    setCallLooksOver(false);
    if (capturingRef.current !== null) {
      setCapturingCallId(null);
      setDeclined("start-failed");
    }
  }, [transcriptFailed]);

  const value = useMemo(
    () => ({
      transcript,
      autoListen,
      autoListenAvailable,
      setAutoListen,
      soundOn,
      setSoundOn,
      micMode,
      setMicMode,
      capturingCallId,
      callLooksOver,
      noteCallOver,
      needsPermission,
      declined,
      noteDecline,
      clearDecline,
      startForCall,
      startManually,
      endCapture,
      resetCapture,
      pauseCapture,
      resumeCapture,
      restartCapture,
    }),
    [
      transcript,
      autoListen,
      autoListenAvailable,
      setAutoListen,
      soundOn,
      setSoundOn,
      micMode,
      setMicMode,
      capturingCallId,
      callLooksOver,
      noteCallOver,
      needsPermission,
      declined,
      noteDecline,
      clearDecline,
      startForCall,
      startManually,
      endCapture,
      resetCapture,
      pauseCapture,
      resumeCapture,
      restartCapture,
    ],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/**
 * Anything outside the provider (the sign-in screens, onboarding) gets an
 * inert session rather than a crash, so a component can ask about the call
 * without caring where it is mounted.
 */
export function useCallCapture(): CallCapture | null {
  return useContext(Context);
}

/**
 * Should a fresh call take over the current capture session?
 *
 * No, if that same call is already being captured — re-announcing a call that
 * is still ringing must not restart the microphone and lose what's been heard.
 */
export function shouldTakeOverCapture(
  capturingCallId: number | null,
  incomingCallId: number,
  listening: boolean,
): boolean {
  if (capturingCallId === incomingCallId) return false;
  // A session already running for another call belongs to a dispatcher who is
  // mid-conversation; the newer call gets the toast, not the microphone.
  if (listening && capturingCallId !== null) return false;
  return true;
}

/**
 * Watch whether the call being followed still reads as live, and say so.
 *
 * It used to end the session here, and that was the single worst bug in live
 * transcription: Quo moves a call off `in_progress` while the two people are
 * still talking, so the microphone was switched off mid-sentence by a hangup
 * that never happened. Now the call list gets a voice, not a veto — the
 * dispatcher sees "this call looks finished" and decides.
 *
 * The abandoned-microphone guarantee moved into the session itself, which
 * retires loudly after a long stretch with nothing heard at all.
 */
export function useNoteCallOver(
  capture: CallCapture | null,
  callStillLive: boolean,
): void {
  const wasLive = useRef(false);
  const note = capture?.noteCallOver;
  const following = capture?.capturingCallId ?? null;
  useEffect(() => {
    if (!note) return;
    if (following === null) {
      wasLive.current = false;
      note(false);
      return;
    }
    if (callStillLive) {
      wasLive.current = true;
      note(false);
      return;
    }
    // Only after it was seen live: a call claimed a moment ago hasn't made it
    // into the list yet, and that is not the same as finished.
    if (wasLive.current) note(true);
  }, [note, following, callStillLive]);
}
