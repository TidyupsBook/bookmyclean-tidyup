import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { CalendarPlus, PhoneCall, PhoneIncoming, X } from "lucide-react";
import {
  useListCalls,
  getListCallsQueryKey,
  useGetCurrentUser,
} from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { formatPhone } from "@/lib/phone";
import {
  attentionIdentity,
  ringingIncomingCall,
  useCallAttention,
} from "@/lib/callAttention";
import { stopRinging } from "@/lib/chime";
import { useCornerOwner } from "@/lib/cornerStack";

/**
 * The always-there way into the booking desk.
 *
 * On a desktop the sidebar's "New Booking" link does this job, but the
 * sidebar is hidden at narrow widths — on a phone or a portrait iPad there
 * was *no* route to the desk at all, and the "a call just finished" nudge
 * was a desktop notification iOS never shows. This button floats on every
 * dashboard screen for anyone entitled to take live calls, and does three
 * things:
 *
 *   - sits quietly when nothing needs attention (tap: fresh blank booking);
 *   - blinks red while a call is ringing (tap: take that call, exactly like
 *     the red banner's button);
 *   - blinks amber while a finished call still waits to be booked (tap: open
 *     the desk for it, form filled from Quo's server-side write-up — no
 *     microphone, no Chrome, so this is the whole flow on an iPhone).
 *
 * What counts as "waiting" comes from the shared call-attention store — the
 * same source as the Calls page "New" markers — so it survives reloads and
 * the two surfaces can never disagree.
 *
 * It never starts the microphone itself. The app-wide call watcher already
 * begins capture the moment a call rings wherever that can actually work, so
 * on a desktop with the mic permitted the desk is reached already listening,
 * and on iOS nothing pretends to listen.
 */

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(REDUCED_MOTION_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = () => setReduced(query.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

export function LiveBookingButton() {
  const [, navigate] = useLocation();
  const { data: me } = useGetCurrentUser();
  const watching = me?.canTakeLiveCalls === true;
  const owner = useCornerOwner();

  /**
   * Same list, same cache key, and deliberately no interval of its own: the
   * app-wide call watcher already polls this query from every page, and a
   * second poller would double the traffic to say the same thing.
   */
  const { data: calls } = useListCalls(undefined, {
    query: {
      queryKey: getListCallsQueryKey(undefined),
      enabled: watching,
    },
  });

  const { waiting, seen, markSeen, markAllSeen } = useCallAttention(
    watching ? attentionIdentity(me) : null,
    watching ? calls : undefined,
  );
  const reduceMotion = usePrefersReducedMotion();

  // The corner decides: hidden for anyone without live-call access, on the
  // booking desk, and while the live-call bar has real work to show.
  if (owner !== "live-booking-launcher") return null;

  const visibleRinging = ringingIncomingCall(calls ?? [], seen);
  const nextWaiting = waiting[0] ?? null;
  const target = visibleRinging ?? nextWaiting;
  const state = visibleRinging ? "ringing" : nextWaiting ? "waiting" : "idle";

  const who = target
    ? target.callerName || formatPhone(target.callerPhone) || "Unknown caller"
    : null;
  const label =
    state === "ringing"
      ? `${who} is currently connected to the receptionist`
      : state === "waiting"
        ? `Book ${who}`
        : "Live booking";
  // More than one call waiting: name the newest, count the rest.
  const others = state === "waiting" ? waiting.length - 1 : 0;

  const Icon =
    state === "ringing"
      ? PhoneIncoming
      : state === "waiting"
        ? CalendarPlus
        : PhoneCall;

  return (
    <div
      className={cn(
        "fixed z-40 print:hidden flex items-center gap-1",
        "right-[max(1rem,env(safe-area-inset-right))]",
        "bottom-[max(1rem,env(safe-area-inset-bottom))]",
      )}
    >
      <button
        type="button"
        onClick={() =>
          navigate(
            target ? `/bookings/new?callId=${target.id}` : "/bookings/new",
          )
        }
        aria-label={label}
        data-testid="button-live-booking"
        data-state={state}
        className={cn(
          // Sized for a thumb, not a pointer.
          "flex min-h-[3rem] items-center gap-2 rounded-full border px-4 py-3",
          "text-sm font-semibold shadow-lg",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          state === "idle" &&
            "border-border bg-card/95 text-foreground backdrop-blur hover-elevate active-elevate-2",
          state === "ringing" && "border-red-700 bg-red-600 text-white",
          state === "waiting" && "border-amber-600 bg-amber-500 text-white",
          // The blink. Suppressed twice over for reduced motion: the JS check
          // covers test environments and old browsers, the CSS variant covers
          // a preference flipped mid-session.
          state !== "idle" && !reduceMotion && "animate-pulse",
          "motion-reduce:animate-none",
        )}
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="max-w-[13rem] truncate">{label}</span>
        {others > 0 && (
          <span
            data-testid="text-live-booking-more"
            className="shrink-0 rounded-full bg-white/25 px-2 py-0.5 text-xs font-bold"
          >
            +{others}
          </span>
        )}
      </button>
      {/* One-tap dismiss for a live alert or an unbooked call — marks the call
          seen without changing the call record, so the dashboard calms down. */}
      {state === "ringing" && visibleRinging && (
        <button
          type="button"
          aria-label="Dismiss alert for this customer connected to the receptionist"
          data-testid="button-live-booking-dismiss-ringing"
          onClick={() => {
            const nextSeen = new Set(seen ?? []);
            nextSeen.add(visibleRinging.id);
            markSeen(visibleRinging.id);
            if (!ringingIncomingCall(calls ?? [], nextSeen)) stopRinging();
          }}
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full shadow-lg",
            "border border-red-700 bg-red-600 text-white",
            "hover:bg-red-500 focus-visible:outline-none focus-visible:ring-2",
            "focus-visible:ring-ring focus-visible:ring-offset-2",
            "transition-colors",
          )}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
      {state === "waiting" && nextWaiting && (
        <button
          type="button"
          aria-label="Not a booking — dismiss"
          data-testid="button-live-booking-dismiss"
          onClick={() => markSeen(nextWaiting.id)}
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full shadow-lg",
            "border border-amber-600 bg-amber-500 text-white",
            "hover:bg-amber-400 focus-visible:outline-none focus-visible:ring-2",
            "focus-visible:ring-ring focus-visible:ring-offset-2",
            "transition-colors",
          )}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
      {state === "waiting" && waiting.length > 1 && (
        <button
          type="button"
          aria-label="Clear all waiting calls"
          data-testid="button-live-booking-clear-all"
          onClick={() => markAllSeen(waiting.map((call) => call.id))}
          className={cn(
            "min-h-[2.25rem] shrink-0 rounded-full px-3 py-2 text-xs font-semibold shadow-lg",
            "border border-amber-600 bg-amber-500 text-white",
            "hover:bg-amber-400 focus-visible:outline-none focus-visible:ring-2",
            "focus-visible:ring-ring focus-visible:ring-offset-2",
            "transition-colors",
          )}
        >
          Clear all
        </button>
      )}
    </div>
  );
}
