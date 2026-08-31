/**
 * @vitest-environment jsdom
 *
 * The sound must never be the reason a page breaks: every one of these cases
 * is a browser saying no in a different way.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

type Recorder = {
  started: number[];
  destinationConnections: number;
  state: string;
  resumed: number;
};

function stubAudio(state: "running" | "suspended" = "running"): Recorder {
  const recorder: Recorder = {
    started: [],
    destinationConnections: 0,
    state,
    resumed: 0,
  };

  class FakeContext {
    currentTime = 0;
    destination = { kind: "destination" };
    get state() {
      return recorder.state;
    }
    resume() {
      recorder.resumed += 1;
      recorder.state = "running";
      return Promise.resolve();
    }
    createOscillator() {
      return {
        type: "",
        frequency: { value: 0 },
        connect: () => {},
        start: (at: number) => recorder.started.push(at),
        stop: () => {},
      };
    }
    createGain() {
      return {
        gain: {
          setValueAtTime: () => {},
          exponentialRampToValueAtTime: () => {},
        },
        connect: (target: { kind?: string }) => {
          if (target.kind === "destination") recorder.destinationConnections++;
        },
      };
    }
  }

  (window as unknown as { AudioContext: unknown }).AudioContext = FakeContext;
  return recorder;
}

beforeEach(() => {
  vi.resetModules();
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  delete (window as unknown as { webkitAudioContext?: unknown })
    .webkitAudioContext;
});

describe("playChime", () => {
  it("plays two notes into the speakers", async () => {
    const recorder = stubAudio();
    const { playChime } = await import("./chime");

    playChime();

    expect(recorder.started).toHaveLength(2);
    // Second note lands after the first, or it's a chord, not a chime.
    expect(recorder.started[1]!).toBeGreaterThan(recorder.started[0]!);
    expect(recorder.destinationConnections).toBe(2);
  });

  it("reuses one audio context across repeated dings", async () => {
    const recorder = stubAudio();
    const { playChime } = await import("./chime");

    playChime();
    playChime();

    // Four notes, still one device: a context per ding eventually hits the
    // browser's limit and the sound stops working altogether.
    expect(recorder.started).toHaveLength(4);
  });

  it("wakes a context the browser had suspended", async () => {
    const recorder = stubAudio("suspended");
    const { playChime } = await import("./chime");

    playChime();

    expect(recorder.resumed).toBeGreaterThan(0);
  });

  it("does nothing at all when the browser has no audio support", async () => {
    const { playChime } = await import("./chime");
    expect(() => playChime()).not.toThrow();
  });

  it("survives a context that refuses to be created", async () => {
    (window as unknown as { AudioContext: unknown }).AudioContext =
      class Blocked {
        constructor() {
          throw new Error("blocked by policy");
        }
      };
    const { playChime } = await import("./chime");
    expect(() => playChime()).not.toThrow();
  });
});

describe("unlockChime", () => {
  it("resumes audio on the first interaction and then stops listening", async () => {
    const recorder = stubAudio("suspended");
    const { unlockChime } = await import("./chime");

    const stop = unlockChime();
    window.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("pointerdown"));

    expect(recorder.resumed).toBe(1);
    stop();
  });

  it("removes its listeners when the app unmounts", async () => {
    const recorder = stubAudio("suspended");
    const { unlockChime } = await import("./chime");

    const stop = unlockChime();
    stop();
    window.dispatchEvent(new Event("keydown"));

    expect(recorder.resumed).toBe(0);
  });
});
