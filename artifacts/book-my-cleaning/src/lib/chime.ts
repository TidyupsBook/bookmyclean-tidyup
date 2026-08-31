/**
 * The "you have a message" sound.
 *
 * Synthesized rather than shipped as an audio file: two sine notes cost no
 * download, can't 404, and can't be blocked as a media resource. The whole
 * thing degrades to silence — no AudioContext (old browser, jsdom, a locked
 * tab) means no sound and no error, because a chat notification is never worth
 * breaking the page over.
 */

type AudioContextConstructor = new () => AudioContext;

let shared: AudioContext | null = null;

function constructorFor(): AudioContextConstructor | null {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return win.AudioContext ?? win.webkitAudioContext ?? null;
}

/**
 * One context for the tab. Browsers cap how many can exist, and each one holds
 * an audio device open, so creating a fresh context per ding eventually goes
 * silent on its own.
 */
function audio(): AudioContext | null {
  if (shared) return shared;
  const Ctor = constructorFor();
  if (!Ctor) return null;
  try {
    shared = new Ctor();
  } catch {
    return null;
  }
  return shared;
}

/**
 * Browsers refuse to start audio until the person has interacted with the
 * page, and a refusal is permanent for that context — so the first click or
 * keypress anywhere resumes it, well before any message needs to announce
 * itself. Returns a cleanup function.
 */
export function unlockChime(): () => void {
  const wake = () => {
    const ctx = audio();
    if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
  };
  const events: Array<keyof WindowEventMap> = [
    "pointerdown",
    "keydown",
    "touchstart",
  ];
  for (const event of events) {
    window.addEventListener(event, wake, { once: true, passive: true });
  }
  return () => {
    for (const event of events) window.removeEventListener(event, wake);
  };
}

type Note = { hz: number; at: number; gain?: number; length?: number };

const PEAK_GAIN = 0.18;
const NOTE_LENGTH = 0.32;

function playNotes(notes: ReadonlyArray<Note>): void {
  const ctx = audio();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});

  try {
    const start = ctx.currentTime;
    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = note.hz;

      // Ramped rather than switched on: a square-edged start is a click, and
      // exponential ramps can't touch zero, hence the near-silent floor.
      const from = start + note.at;
      const length = note.length ?? NOTE_LENGTH;
      gain.gain.setValueAtTime(0.0001, from);
      gain.gain.exponentialRampToValueAtTime(
        note.gain ?? PEAK_GAIN,
        from + 0.012,
      );
      gain.gain.exponentialRampToValueAtTime(0.0001, from + length);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(from);
      osc.stop(from + length + 0.02);
    }
  } catch {
    // A browser that refuses to play is not an error worth surfacing.
  }
}

/** A new message: two short notes, quiet enough to sit under a conversation. */
export function playChime(): void {
  playNotes([
    { hz: 880, at: 0 },
    { hz: 1174.66, at: 0.1 },
  ]);
}

/**
 * The phone is ringing. Deliberately not the message sound: this one has to
 * be recognisable from across the office and is worth interrupting for, so it
 * rises, repeats, and rings a little louder and longer.
 */
export function playCallAlert(): void {
  const ring: Note[] = [];
  for (const offset of [0, 0.55]) {
    ring.push(
      { hz: 987.77, at: offset, gain: 0.24, length: 0.22 },
      { hz: 1318.51, at: offset + 0.16, gain: 0.24, length: 0.22 },
      { hz: 1567.98, at: offset + 0.32, gain: 0.2, length: 0.4 },
    );
  }
  playNotes(ring);
}

/**
 * A real telephone ring: the call-alert sound repeated on a phone's cadence
 * until someone reacts, the call ends, or it has rung its fill. One-shot
 * sounds are exactly what "I didn't hear the phone" is made of — the owner
 * across the room needs it to keep ringing.
 *
 * Any click or keypress anywhere counts as "heard it" and falls silent, so
 * the ring can never talk over someone already working the call.
 */
const RING_EVERY_MS = 2_750;
const MAX_RINGS = 8;

let ringTimer: ReturnType<typeof setInterval> | null = null;
let removeRingListeners: (() => void) | null = null;

export function stopRinging(): void {
  if (ringTimer !== null) {
    clearInterval(ringTimer);
    ringTimer = null;
  }
  removeRingListeners?.();
  removeRingListeners = null;
}

export function isRinging(): boolean {
  return ringTimer !== null;
}

export function startRinging(): void {
  if (ringTimer !== null) return; // already ringing — don't double up
  let rings = 0;
  const ringOnce = () => {
    rings += 1;
    playCallAlert();
    if (rings >= MAX_RINGS) stopRinging();
  };
  ringOnce();
  ringTimer = setInterval(ringOnce, RING_EVERY_MS);

  const heard = () => stopRinging();
  window.addEventListener("pointerdown", heard);
  window.addEventListener("keydown", heard);
  removeRingListeners = () => {
    window.removeEventListener("pointerdown", heard);
    window.removeEventListener("keydown", heard);
  };
}
