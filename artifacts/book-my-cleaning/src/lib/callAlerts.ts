import type { Call } from "@workspace/api-client-react";

/**
 * Which calls are worth interrupting whoever is on dispatch: ringing now, or
 * finished within the last few minutes (someone who left a voicemail while the
 * dispatcher was looking at the map still needs calling back).
 */
const RECENT_MS = 5 * 60_000;

/**
 * Calls the office placed itself are never news. Older records can have no
 * direction recorded at all, and those are treated as incoming — a missed
 * customer is a far worse outcome than one popup about an outgoing call.
 */
function isIncoming(call: Call): boolean {
  return call.direction !== "outbound";
}

/**
 * `booked` means someone has already dealt with it, so it is deliberately not
 * announced — otherwise taking the booking pops a notification about the call
 * you just finished handling.
 */
const ANNOUNCEABLE_ENDINGS = new Set(["completed", "missed"]);

export function callsWorthAnnouncing(calls: Call[], now: number): Call[] {
  return calls.filter((call) => {
    if (!isIncoming(call)) return false;
    if (call.status === "in_progress") return true;
    if (!ANNOUNCEABLE_ENDINGS.has(call.status)) return false;
    const started = new Date(call.startedAt).getTime();
    if (!Number.isFinite(started)) return false;
    const age = now - started;
    // Negative age means a clock skew, not a call from the future.
    return age >= -RECENT_MS && age <= RECENT_MS;
  });
}

/**
 * The `callId` handed over by the "Take booking" popup. Anything that isn't a
 * real row id is treated as absent rather than coerced into one.
 */
export function parseCallIdParam(search: string): number | null {
  const raw = new URLSearchParams(search).get("callId");
  if (!raw) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
