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
 *  - recognition stops itself after a pause, so we restart it while the
 *    dispatcher still has it switched on. Without that it dies quietly a few
 *    seconds in and looks broken.
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
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

function recognitionConstructor(): SpeechRecognitionConstructor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type LiveTranscript = {
  supported: boolean;
  listening: boolean;
  /** Everything recognised so far this session. */
  text: string;
  /** The phrase currently being spoken, not yet settled. */
  interim: string;
  /** Set when the browser refused — usually a denied microphone. */
  error: string | null;
  start: () => void;
  stop: () => void;
  clear: () => void;
};

export function useLiveTranscript(): LiveTranscript {
  const [supported] = useState(() => recognitionConstructor() != null);
  const [listening, setListening] = useState(false);
  const [text, setText] = useState("");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  // Read inside `onend`, which is why it is a ref: the handler is installed
  // once and would otherwise close over whatever `listening` was at the time.
  const wantListeningRef = useRef(false);

  const stop = useCallback(() => {
    wantListeningRef.current = false;
    setListening(false);
    setInterim("");
    recognitionRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Ctor = recognitionConstructor();
    if (!Ctor) return;
    if (recognitionRef.current) return;

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-CA";

    recognition.onresult = (event) => {
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
      // "no-speech" and "aborted" are ordinary quiet moments, not failures.
      if (event.error === "no-speech" || event.error === "aborted") return;
      setError(
        event.error === "not-allowed"
          ? "Microphone access was blocked. Allow it in your browser and try again."
          : `Microphone stopped: ${event.error}`,
      );
      wantListeningRef.current = false;
      setListening(false);
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      // Recognition ends itself after a pause. Restart only while the
      // dispatcher still has it switched on, so stopping actually stops.
      if (wantListeningRef.current) start();
    };

    recognitionRef.current = recognition;
    wantListeningRef.current = true;
    setError(null);
    try {
      recognition.start();
      setListening(true);
    } catch {
      // Already running — harmless, and the existing session keeps going.
      recognitionRef.current = recognition;
    }
  }, []);

  const clear = useCallback(() => {
    setText("");
    setInterim("");
  }, []);

  // Leaving the page must release the microphone, or the browser keeps the
  // recording indicator lit long after the dispatcher has moved on.
  useEffect(() => {
    return () => {
      wantListeningRef.current = false;
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  return { supported, listening, text, interim, error, start, stop, clear };
}
