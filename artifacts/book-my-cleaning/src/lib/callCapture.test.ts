import { describe, expect, it } from "vitest";
import {
  captureGuidance,
  listeningHint,
  quietMicMessage,
  shouldTakeOverCapture,
} from "./callCapture";

/**
 * A ringing call is re-announced on every poll until it is answered, so the
 * rule that decides whether to (re)start the microphone is the one thing
 * standing between the dispatcher and a transcript that resets every ten
 * seconds.
 */
describe("shouldTakeOverCapture", () => {
  it("starts when nothing is being captured", () => {
    expect(shouldTakeOverCapture(null, 42, false)).toBe(true);
  });

  it("does not restart for the call it is already following", () => {
    expect(shouldTakeOverCapture(42, 42, true)).toBe(false);
  });

  it("leaves a live session alone when a second call comes in", () => {
    // The dispatcher is mid-conversation. The new call gets the popup; taking
    // the microphone away would throw out the words of the call they're on.
    expect(shouldTakeOverCapture(42, 43, true)).toBe(false);
  });

  it("takes over once the previous session has stopped", () => {
    expect(shouldTakeOverCapture(42, 43, false)).toBe(true);
  });
});

/**
 * The coaching copy is the earbuds feature: on speaker a silent microphone
 * is a fault and "put them on speaker" is the fix, but on earbuds silence is
 * the customer talking and speakerphone is exactly what the owner chose not
 * to use. A future rewording that reintroduces the speaker nag into the
 * earbuds lines would quietly undo the mode.
 */
describe("mic mode coaching copy", () => {
  it("never mentions speakerphone in earbuds mode", () => {
    expect(quietMicMessage("earbuds")).not.toMatch(/speaker/i);
    expect(listeningHint("earbuds")).not.toMatch(/speaker/i);
  });

  it("coaches repeating details back in earbuds mode", () => {
    expect(quietMicMessage("earbuds")).toMatch(/say it back|repeat/i);
    expect(listeningHint("earbuds")).toMatch(/repeat/i);
  });

  it("does not treat earbuds silence as a fault", () => {
    expect(quietMicMessage("earbuds")).toMatch(/normal/i);
  });

  it("keeps the speakerphone nudge in speaker mode", () => {
    expect(quietMicMessage("speaker")).toMatch(/speaker/i);
    expect(listeningHint("speaker")).toMatch(/fills itself/i);
  });

  it("teaches the right habit for each mode", () => {
    expect(captureGuidance("earbuds")).toMatch(/repeat/i);
    expect(captureGuidance("earbuds")).not.toMatch(
      /put the caller on speaker/i,
    );
    expect(captureGuidance("speaker")).toMatch(/put the caller on speaker/i);
  });

  it("tells the truth about where the words go", () => {
    // The transcript text is sent to the company's own server to fill the
    // form — a privacy promise that the words "never leave this computer"
    // would be false, and must not be reintroduced by a rewording.
    for (const mode of ["speaker", "earbuds"] as const) {
      expect(captureGuidance(mode)).not.toMatch(/never leaves?|stays on this/i);
      expect(captureGuidance(mode)).toMatch(/booking server/i);
      expect(captureGuidance(mode)).toMatch(/no audio is recorded/i);
    }
  });
});
