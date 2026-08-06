import { describe, expect, it } from "vitest";
import { callsWorthAnnouncing, parseCallIdParam } from "./callAlerts";
import type { Call } from "@workspace/api-client-react";

const NOW = Date.parse("2026-08-06T19:00:00.000Z");

function call(overrides: Partial<Call>): Call {
  return {
    id: 1,
    callerName: "Pat",
    callerPhone: "+15550001111",
    status: "completed",
    startedAt: new Date(NOW).toISOString(),
    durationSeconds: 60,
    isTest: false,
    ...overrides,
  } as Call;
}

describe("callsWorthAnnouncing", () => {
  it("announces a call that is ringing right now", () => {
    const ringing = call({ id: 7, status: "in_progress" });
    expect(callsWorthAnnouncing([ringing], NOW).map((c) => c.id)).toEqual([7]);
  });

  it("announces a call that just finished, so a callback isn't missed", () => {
    const justEnded = call({
      id: 8,
      startedAt: new Date(NOW - 60_000).toISOString(),
    });
    expect(callsWorthAnnouncing([justEnded], NOW).map((c) => c.id)).toEqual([
      8,
    ]);
  });

  it("stays quiet about calls from earlier in the day", () => {
    const old = call({
      id: 9,
      startedAt: new Date(NOW - 3 * 60 * 60_000).toISOString(),
    });
    expect(callsWorthAnnouncing([old], NOW)).toEqual([]);
  });

  it("stays quiet about calls the office placed itself", () => {
    const outbound = call({
      id: 10,
      status: "in_progress",
      direction: "outbound",
    });
    expect(callsWorthAnnouncing([outbound], NOW)).toEqual([]);
  });

  it("survives a call with an unusable timestamp", () => {
    const broken = call({ id: 11, startedAt: "not a date" });
    expect(callsWorthAnnouncing([broken], NOW)).toEqual([]);
  });

  it("still announces a call with no direction recorded", () => {
    const unknown = call({ id: 12, direction: null });
    expect(callsWorthAnnouncing([unknown], NOW).map((c) => c.id)).toEqual([12]);
  });

  it("announces a missed call, which is the one most worth catching", () => {
    const missed = call({ id: 13, status: "missed" });
    expect(callsWorthAnnouncing([missed], NOW).map((c) => c.id)).toEqual([13]);
  });

  it("stays quiet once a call has been turned into a booking", () => {
    const booked = call({ id: 14, status: "booked" });
    expect(callsWorthAnnouncing([booked], NOW)).toEqual([]);
  });
});

describe("parseCallIdParam", () => {
  it("reads the id handed over by the popup", () => {
    expect(parseCallIdParam("?callId=42")).toBe(42);
  });

  it("treats junk as no id at all rather than call zero", () => {
    for (const search of [
      "",
      "?callId=",
      "?callId=abc",
      "?callId=-3",
      "?callId=1.5",
    ]) {
      expect(parseCallIdParam(search)).toBeNull();
    }
  });
});
