import { describe, expect, it } from "vitest";
import {
  captureStatusLabel,
  formatElapsed,
  micErrorFatal,
  micErrorMessage,
  reconnectDelayMs,
} from "./speech";

/**
 * The whole value of these messages is that a dispatcher can act on them
 * without calling anyone. An empty transcript box says nothing; "your browser
 * blocked the microphone, click the padlock" is a fix.
 */
describe("micErrorMessage", () => {
  it("stays quiet for a pause in the conversation", () => {
    expect(micErrorMessage("no-speech")).toBeNull();
  });

  it("stays quiet when we stopped it ourselves", () => {
    expect(micErrorMessage("aborted")).toBeNull();
  });

  it("says how to unblock a refused microphone", () => {
    for (const code of ["not-allowed", "service-not-allowed"]) {
      expect(micErrorMessage(code)).toMatch(/padlock/i);
    }
  });

  it("separates 'no microphone' from 'microphone refused'", () => {
    expect(micErrorMessage("audio-capture")).toMatch(/no microphone/i);
    expect(micErrorMessage("audio-capture")).not.toMatch(/padlock/i);
  });

  it("names the connection when the speech service is unreachable", () => {
    expect(micErrorMessage("network")).toMatch(/connection/i);
  });

  it("still reports a code nobody has seen before", () => {
    expect(micErrorMessage("weird-new-code")).toBe(
      "The microphone stopped: weird-new-code.",
    );
  });
});

/**
 * This split is the difference between a session that lasts a phone call and
 * one that dies in the first ten seconds. Retrying a refused microphone is a
 * lie; giving up on Chrome's speech service blipping is the bug that made
 * live transcription unusable.
 */
describe("micErrorFatal", () => {
  it("treats a refused or missing microphone as unrecoverable", () => {
    for (const code of [
      "not-allowed",
      "service-not-allowed",
      "audio-capture",
      "language-not-supported",
    ]) {
      expect(micErrorFatal(code)).toBe(true);
    }
  });

  it("treats a speech-service blip as something to reconnect through", () => {
    expect(micErrorFatal("network")).toBe(false);
  });

  it("gives an unknown code the benefit of the doubt and retries it", () => {
    expect(micErrorFatal("weird-new-code")).toBe(false);
  });
});

describe("reconnectDelayMs", () => {
  it("reopens immediately the first time", () => {
    // Recognition ending after a natural pause is the common case by a mile;
    // a delay there drops words out of the middle of a sentence.
    expect(reconnectDelayMs(0)).toBe(0);
  });

  it("backs off once attempts start failing back to back", () => {
    expect(reconnectDelayMs(1)).toBeGreaterThan(0);
    expect(reconnectDelayMs(2)).toBeGreaterThan(reconnectDelayMs(1));
    expect(reconnectDelayMs(3)).toBeGreaterThan(reconnectDelayMs(2));
  });

  it("stops growing rather than waiting minutes between tries", () => {
    expect(reconnectDelayMs(99)).toBe(reconnectDelayMs(5));
    expect(reconnectDelayMs(99)).toBeLessThanOrEqual(10_000);
  });
});

describe("the status line", () => {
  it("names each state the way a dispatcher would say it", () => {
    expect(captureStatusLabel("listening")).toBe("Listening");
    expect(captureStatusLabel("paused")).toBe("Paused");
    expect(captureStatusLabel("reconnecting")).toBe("Reconnecting");
    expect(captureStatusLabel("stopped")).toBe("Stopped");
  });

  it("counts the session in minutes and seconds", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(9_000)).toBe("0:09");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(11 * 60_000 + 7_000)).toBe("11:07");
  });
});
