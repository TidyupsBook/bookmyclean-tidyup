import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { Call } from "@workspace/api-client-react";
import { incomingCallToAlert, isIncoming } from "@/lib/callAlerts";

/**
 * One shared idea of which calls still need a person's attention.
 *
 * Two surfaces read it — the "New" markers on the Calls page and the floating
 * Live booking launcher — and they must never disagree about what is waiting
 * or which active alert was dismissed. So the rule lives here, once:
 *
 *   A call is WAITING when it is incoming, it has ended without being booked
 *   (`completed` or `missed`), and nobody has engaged with it yet.
 *
 * "Engaged" means someone opened it — its detail on the Calls page, or the
 * booking desk with that call named. Dismissing a live alert uses the same
 * per-call marker without changing the call itself. Deliberately *not* a timer: the old
 * five-minute announcement window is fine for a toast, but "this call still
 * needs booking" is true until someone acts on it, however long that takes.
 * And deliberately not "the list was looked at": glancing at the Calls page
 * on the way to the map is not dealing with a call.
 *
 * The seen-set persists per signed-in identity (same `email@company` string
 * the call announcer keys its session by), so a reload — or an overnight
 * pause — does not silently absolve every unbooked call. `booked` needs no
 * bookkeeping at all: taking the booking changes the call's own status, which
 * removes it from WAITING on every device at once. The same set also records
 * an explicitly dismissed live call, so it stays quiet when its status later
 * changes to `completed` or `missed`.
 */

const KEY_PREFIX = "bmc.callAttention.v1.";

/**
 * How many seen ids are kept. Ids are serial, so keeping the largest ones
 * keeps the newest; anything old enough to fall off this list is months of
 * calls away from ever being flagged again.
 */
const MAX_REMEMBERED = 500;

/** Ended without being booked. `booked` clears itself via the status. */
const AWAITING_ENDINGS = new Set<string>(["completed", "missed"]);

/**
 * The per-identity seen-sets, plus a version counter so React consumers can
 * subscribe. localStorage is the durable copy; this map is the working copy,
 * which also carries a locked-down browser (storage refused) through the
 * session instead of flagging everything forever.
 */
const cached = new Map<string, Set<number>>();
const listeners = new Set<() => void>();
let version = 0;

/**
 * Ids marked seen before the store was primed (the booking desk can be the
 * first page of a first-ever session). They are folded into the baseline at
 * prime time rather than written immediately — writing would *create* the
 * store, and a store born with one id in it reads every historical call as
 * news.
 */
const pendingSeen = new Map<string, Set<number>>();

function bump(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getVersion(): number {
  return version;
}

function storageKey(identity: string): string {
  return KEY_PREFIX + identity;
}

function readStorage(key: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or storage disabled: the in-memory copy still works for
    // this session; it just won't survive a reload.
  }
}

// Another tab marking a call seen must not leave this one blinking for it.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key && event.key.startsWith(KEY_PREFIX)) {
      cached.delete(event.key.slice(KEY_PREFIX.length));
      bump();
    }
  });
}

/**
 * The identity a seen-set belongs to. Matches the session string the call
 * announcer uses: call ids from another company can collide, so a shared
 * machine must never inherit the previous account's "already handled" list.
 */
export function attentionIdentity(
  me: { email?: string | null; companyName?: string | null } | null | undefined,
): string | null {
  if (!me?.email || !me.companyName) return null;
  return `${me.email}@${me.companyName}`;
}

/**
 * The seen ids for this identity, or `null` when this identity has never
 * been primed — in which case nothing may be treated as waiting, because
 * "everything ever" would be flagged on a first sign-in.
 */
export function seenCalls(identity: string): ReadonlySet<number> | null {
  const hit = cached.get(identity);
  if (hit) return hit;
  const raw = readStorage(storageKey(identity));
  if (raw === null) return null;
  let ids: number[] = [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      ids = parsed.filter((n): n is number => typeof n === "number");
    }
  } catch {
    // A corrupt record reads as an empty (but primed) set: worst case a few
    // old calls flag once more, which beats never flagging again.
  }
  const set = new Set(ids);
  cached.set(identity, set);
  return set;
}

function persist(identity: string, seen: Set<number>): void {
  cached.set(identity, seen);
  const ids = [...seen];
  const trimmed =
    ids.length > MAX_REMEMBERED
      ? ids.sort((a, b) => b - a).slice(0, MAX_REMEMBERED)
      : ids;
  writeStorage(storageKey(identity), JSON.stringify(trimmed));
  bump();
}

/**
 * First contact between this identity and the call list. Everything already
 * finished is history, not news — except a call ringing right now, which is
 * the one the dashboard was opened *for*: it is left unseen so that when it
 * ends it waits like any other call.
 */
export function primeCallAttention(identity: string, calls: Call[]): void {
  if (seenCalls(identity) !== null) return;
  const baseline = new Set(
    calls.filter((c) => c.status !== "in_progress").map((c) => c.id),
  );
  for (const id of pendingSeen.get(identity) ?? []) baseline.add(id);
  pendingSeen.delete(identity);
  persist(identity, baseline);
}

/** Someone engaged with this call; it stops waiting everywhere at once. */
export function markCallSeen(identity: string, callId: number): void {
  markCallsSeen(identity, [callId]);
}

/** Mark several calls handled in one store update without changing the rows. */
export function markCallsSeen(identity: string, callIds: number[]): void {
  if (callIds.length === 0) return;
  const current = seenCalls(identity);
  if (current === null) {
    let pending = pendingSeen.get(identity);
    if (!pending) pendingSeen.set(identity, (pending = new Set()));
    for (const callId of callIds) pending.add(callId);
    return;
  }
  const next = new Set(current);
  let changed = false;
  for (const callId of callIds) {
    if (!next.has(callId)) {
      next.add(callId);
      changed = true;
    }
  }
  if (!changed) return;
  persist(identity, next);
}

/** Whether this call has already been handled or explicitly dismissed. */
export function isCallSeen(identity: string, callId: number): boolean {
  return seenCalls(identity)?.has(callId) ?? false;
}

/**
 * The calls still waiting to be turned into bookings, newest first (list
 * order). Test calls are included on purpose — the Test Call button is how
 * an owner rehearses exactly this flow — but they never *ring* anything.
 */
export function callsAwaitingBooking(
  calls: Call[],
  seen: ReadonlySet<number> | null,
): Call[] {
  if (seen === null) return [];
  return calls.filter(
    (call) =>
      isIncoming(call) &&
      AWAITING_ENDINGS.has(call.status) &&
      !seen.has(call.id),
  );
}

/**
 * The call ringing right now, if any. Mirrors the red incoming-call banner
 * exactly: incoming, live, and never a test call — the two must light up for
 * the same call or neither.
 */
export function ringingIncomingCall(
  calls: Call[],
  seen?: ReadonlySet<number> | null,
): Call | null {
  return incomingCallToAlert(calls, seen);
}

/**
 * React view of the shared state. Both consumers pass the calls list they
 * already have (nobody polls anything new here) and get back the same
 * waiting set, kept in step across components and tabs.
 */
export function useCallAttention(
  identity: string | null,
  calls: Call[] | undefined,
): {
  waiting: Call[];
  isWaiting: (callId: number) => boolean;
  seen: ReadonlySet<number> | null;
  markSeen: (callId: number) => void;
  markAllSeen: (callIds: number[]) => void;
} {
  const stamp = useSyncExternalStore(subscribe, getVersion, getVersion);

  useEffect(() => {
    if (identity && calls) primeCallAttention(identity, calls);
  }, [identity, calls]);

  const seen = useMemo(
    () => (identity ? seenCalls(identity) : null),
    [identity, stamp],
  );

  const waiting = useMemo(() => {
    if (!identity || !calls) return [];
    return callsAwaitingBooking(calls, seen);
    // `stamp` is the subscription's change signal for the seen-set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, calls, seen, stamp]);

  const markSeen = useCallback(
    (callId: number) => {
      if (identity) markCallSeen(identity, callId);
    },
    [identity],
  );

  const markAllSeen = useCallback(
    (callIds: number[]) => {
      if (identity) markCallsSeen(identity, callIds);
    },
    [identity],
  );

  const isWaiting = useCallback(
    (callId: number) => waiting.some((call) => call.id === callId),
    [waiting],
  );

  return { waiting, isWaiting, seen, markSeen, markAllSeen };
}
