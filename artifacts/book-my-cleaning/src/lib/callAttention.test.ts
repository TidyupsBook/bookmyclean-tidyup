// @vitest-environment jsdom
/**
 * The shared "which calls still need booking" store. Both the Calls page
 * "New" markers and the Live booking launcher read it, so these tests pin
 * the rules they must agree on: history is not news, a waiting call does not
 * evaporate on reload, and only engagement (or the booking itself) clears it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Call } from "@workspace/api-client-react";

type AttentionModule = typeof import("./callAttention");

/** A fresh module instance = a page reload. localStorage survives it. */
async function boot(): Promise<AttentionModule> {
  vi.resetModules();
  return await import("./callAttention");
}

let nextIdentity = 0;
let identity = "";

beforeEach(() => {
  localStorage.clear();
  identity = `owner-${++nextIdentity}@Sparkle`;
});

function call(over: Partial<Call> & { id: number }): Call {
  return {
    callerName: "Dana",
    callerPhone: "+15550001111",
    status: "completed",
    startedAt: "2026-08-14T12:00:00Z",
    durationSeconds: 60,
    isTest: false,
    direction: "inbound",
    ...over,
  } as Call;
}

describe("priming", () => {
  it("treats everything already finished at first sight as history", async () => {
    const m = await boot();
    const history = [call({ id: 1 }), call({ id: 2, status: "missed" })];
    // Before priming nothing may wait — flagging months of history on a
    // first sign-in would bury the one call that matters.
    expect(m.callsAwaitingBooking(history, m.seenCalls(identity))).toEqual([]);
    m.primeCallAttention(identity, history);
    expect(m.callsAwaitingBooking(history, m.seenCalls(identity))).toEqual([]);
  });

  it("leaves a call ringing at first sight unseen, so it waits once it ends", async () => {
    const m = await boot();
    const ringing = call({ id: 7, status: "in_progress" });
    m.primeCallAttention(identity, [ringing, call({ id: 1 })]);
    const ended = call({ id: 7, status: "completed" });
    const waiting = m.callsAwaitingBooking([ended], m.seenCalls(identity));
    expect(waiting.map((c) => c.id)).toEqual([7]);
  });

  it("only primes once — later calls are news, not baseline", async () => {
    const m = await boot();
    m.primeCallAttention(identity, [call({ id: 1 })]);
    m.primeCallAttention(identity, [call({ id: 1 }), call({ id: 2 })]);
    const waiting = m.callsAwaitingBooking(
      [call({ id: 1 }), call({ id: 2 })],
      m.seenCalls(identity),
    );
    expect(waiting.map((c) => c.id)).toEqual([2]);
  });
});

describe("what counts as waiting", () => {
  it("flags finished and missed incoming calls until someone engages", async () => {
    const m = await boot();
    m.primeCallAttention(identity, []);
    const calls = [
      call({ id: 10 }),
      call({ id: 11, status: "missed" }),
      call({ id: 12, status: "booked" }),
      call({ id: 13, status: "in_progress" }),
      call({ id: 14, direction: "outbound" }),
    ];
    const waiting = m.callsAwaitingBooking(calls, m.seenCalls(identity));
    expect(waiting.map((c) => c.id)).toEqual([10, 11]);
  });

  it("includes test calls — the Test Call button rehearses this exact flow", async () => {
    const m = await boot();
    m.primeCallAttention(identity, []);
    const waiting = m.callsAwaitingBooking(
      [call({ id: 20, isTest: true })],
      m.seenCalls(identity),
    );
    expect(waiting.map((c) => c.id)).toEqual([20]);
  });

  it("stops waiting once marked seen", async () => {
    const m = await boot();
    m.primeCallAttention(identity, []);
    m.markCallSeen(identity, 30);
    const waiting = m.callsAwaitingBooking(
      [call({ id: 30 })],
      m.seenCalls(identity),
    );
    expect(waiting).toEqual([]);
  });

  it("marks several waiting calls seen without changing the call rows", async () => {
    const m = await boot();
    m.primeCallAttention(identity, []);
    const calls = [call({ id: 35 }), call({ id: 36 })];

    m.markCallsSeen(
      identity,
      calls.map((item) => item.id),
    );

    expect(m.callsAwaitingBooking(calls, m.seenCalls(identity))).toEqual([]);
    expect(calls).toEqual([call({ id: 35 }), call({ id: 36 })]);
  });

  it("dismisses a live call without losing its completed record or future calls", async () => {
    const m = await boot();
    m.primeCallAttention(identity, []);
    const live = call({ id: 31, status: "in_progress" });

    expect(m.ringingIncomingCall([live], m.seenCalls(identity))?.id).toBe(31);
    m.markCallSeen(identity, live.id);

    expect(m.ringingIncomingCall([live], m.seenCalls(identity))).toBeNull();
    expect(
      m.callsAwaitingBooking(
        [call({ id: live.id, status: "completed" })],
        m.seenCalls(identity),
      ),
    ).toEqual([]);

    const future = call({ id: 32, status: "in_progress" });
    expect(m.ringingIncomingCall([future], m.seenCalls(identity))?.id).toBe(32);
  });

  it("skips a dismissed live call and finds another active incoming call", async () => {
    const m = await boot();
    m.primeCallAttention(identity, []);
    m.markCallSeen(identity, 33);

    expect(
      m.ringingIncomingCall(
        [
          call({ id: 33, status: "in_progress" }),
          call({ id: 34, status: "in_progress" }),
        ],
        m.seenCalls(identity),
      )?.id,
    ).toBe(34);
  });
});

describe("surviving a reload", () => {
  it("a waiting call is still waiting after the page reloads", async () => {
    let m = await boot();
    m.primeCallAttention(identity, [call({ id: 1 })]);
    // Call 2 arrives later and waits...
    const calls = [call({ id: 2 }), call({ id: 1 })];
    expect(
      m.callsAwaitingBooking(calls, m.seenCalls(identity)).map((c) => c.id),
    ).toEqual([2]);
    // ...and a reload must not absolve it.
    m = await boot();
    expect(
      m.callsAwaitingBooking(calls, m.seenCalls(identity)).map((c) => c.id),
    ).toEqual([2]);
  });

  it("a call marked seen stays seen after the page reloads", async () => {
    let m = await boot();
    m.primeCallAttention(identity, []);
    m.markCallSeen(identity, 5);
    m = await boot();
    expect(
      m.callsAwaitingBooking([call({ id: 5 })], m.seenCalls(identity)),
    ).toEqual([]);
  });
});

describe("marking seen before the store exists", () => {
  it("does not turn all of history into news", async () => {
    const m = await boot();
    // The booking desk can be the first page of a first-ever session: it
    // marks its call seen before any list has primed the store.
    m.markCallSeen(identity, 50);
    m.primeCallAttention(identity, [call({ id: 49 }), call({ id: 50 })]);
    const waiting = m.callsAwaitingBooking(
      [call({ id: 49 }), call({ id: 50 })],
      m.seenCalls(identity),
    );
    expect(waiting).toEqual([]);
  });
});

describe("identities", () => {
  it("keeps one signed-in identity's seen list away from another's", async () => {
    const m = await boot();
    const other = `${identity}-other`;
    m.primeCallAttention(identity, []);
    m.primeCallAttention(other, []);
    m.markCallSeen(identity, 1);
    expect(
      m.callsAwaitingBooking([call({ id: 1 })], m.seenCalls(other)),
    ).toHaveLength(1);
  });

  it("builds the identity from email and company, and refuses half of one", async () => {
    const m = await boot();
    expect(
      m.attentionIdentity({ email: "a@b.c", companyName: "Sparkle" }),
    ).toBe("a@b.c@Sparkle");
    expect(m.attentionIdentity({ email: "a@b.c" })).toBeNull();
    expect(m.attentionIdentity(undefined)).toBeNull();
  });
});

describe("ringing", () => {
  it("mirrors the red banner: incoming and live, never a test call", async () => {
    const m = await boot();
    expect(
      m.ringingIncomingCall([
        call({ id: 1, status: "in_progress", isTest: true }),
        call({ id: 2, status: "in_progress", direction: "outbound" }),
        call({ id: 3, status: "completed" }),
        call({ id: 4, status: "in_progress" }),
      ])?.id,
    ).toBe(4);
    expect(m.ringingIncomingCall([call({ id: 3 })])).toBeNull();
  });
});

describe("the remembered list stays bounded", () => {
  it("keeps the newest ids when trimming", async () => {
    let m = await boot();
    m.primeCallAttention(identity, []);
    for (let id = 1; id <= 520; id++) m.markCallSeen(identity, id);
    m = await boot();
    const seen = m.seenCalls(identity);
    expect(seen?.size).toBe(500);
    expect(seen?.has(520)).toBe(true);
    expect(seen?.has(1)).toBe(false);
  });
});
