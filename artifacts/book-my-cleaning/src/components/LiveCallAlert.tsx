import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { Phone } from "lucide-react";
import {
  useListCalls,
  getListCallsQueryKey,
  useGetCurrentUser,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { callsWorthAnnouncing } from "@/lib/callAlerts";
import { playCallAlert, startRinging, stopRinging } from "@/lib/chime";
import { popUp } from "@/lib/desktopNotify";
import {
  attentionIdentity,
  ringingIncomingCall,
  useCallAttention,
} from "@/lib/callAttention";
import {
  shouldTakeOverCapture,
  useCallCapture,
  useNoteCallOver,
} from "@/lib/callCapture";

/**
 * Tells whoever is on dispatch that the phone just rang, wherever they happen
 * to be in the app, and hands them a one-click way into the booking desk with
 * that call already loaded.
 *
 * Before this, a call was only visible to someone already sitting on the Calls
 * page or the booking desk. Anyone looking at the map or the schedule missed
 * it entirely, which is the moment that matters most.
 *
 * Three separate ways of saying it, because each one fails on its own: a toast
 * for someone looking at the app, a sound for someone looking away from the
 * screen, and a desktop pop-up for someone in another window entirely. The
 * same moment also starts the live transcription, so the words are being
 * caught before anyone has clicked anything.
 */
const POLL_MS = 10_000;

/**
 * Which calls have already been announced. Module scope on purpose: the layout
 * remounts on every page change, and a per-component ref would re-announce the
 * same call each time the dispatcher clicked something.
 */
const announced = new Set<number>();
/** The first list after a page load is history, not news. */
let primed = false;
/**
 * Who that state belongs to. Signing out and in as someone else — a different
 * office entirely, on a shared machine — must not inherit the last person's
 * "already told them" list, since call ids from another company can collide.
 */
let primedFor: string | null = null;

export function LiveCallAlert() {
  const [location, navigate] = useLocation();
  const { toast } = useToast();
  const { data: me } = useGetCurrentUser();
  const capture = useCallCapture();

  // Only the people who may actually take the booking are told about a live
  // call: the owner, and any dispatcher he has switched live-call dispatching
  // on for (a toggle on their staff card). The server computes the flag, so
  // this can't drift from what the form-filling routes would accept.
  const watching = me?.canTakeLiveCalls === true;
  const onBookingDesk = location.startsWith("/bookings/new");
  const attentionId = attentionIdentity(me);

  const followed = capture?.capturingCallId ?? null;
  const sessionOpen = capture?.transcript.active ?? false;

  /**
   * The booking desk runs its own poll on the same list, so stepping aside
   * there keeps this from doubling the traffic for no extra news — except
   * while a session is open. The desk stops polling once it flips to the
   * microphone tab, and something has to keep watching the call, or the
   * "this call looks finished" note never arrives.
   */
  const { data: calls } = useListCalls(undefined, {
    query: {
      queryKey: getListCallsQueryKey(undefined),
      refetchInterval:
        watching && (!onBookingDesk || followed !== null || sessionOpen)
          ? POLL_MS
          : false,
      enabled: watching,
    },
  });
  const { seen, markSeen } = useCallAttention(
    watching ? attentionId : null,
    watching ? calls : undefined,
  );

  const session = me ? `${me.email}@${me.companyName}` : null;

  /**
   * Whether the call being transcribed still reads as live. This is a note
   * beside the transcript and nothing more — Quo moves a call off
   * `in_progress` while the two people are still talking, and cutting the
   * microphone on that signal is what killed live capture mid-sentence.
   */
  const followedStillLive = (calls ?? []).some(
    (call) => call.id === followed && call.status === "in_progress",
  );
  // Only the owner's watch feeds this. Someone who isn't watching gets no
  // call list, so every call would read as "over" and quietly cut a session
  // that isn't theirs to judge.
  useNoteCallOver(watching ? capture : null, followedStillLive);

  /**
   * Live calls are the owner's, so a session must not outlive his access. If
   * his role changes while the microphone is running — demoted on another
   * device, or signed out and back in as someone else — the words stop here
   * rather than carrying on under an identity the server would refuse.
   */
  const endCapture = capture?.endCapture;
  const sessionRunning = capture?.transcript.active ?? false;
  useEffect(() => {
    // Undefined role means "still loading", which is not the same as demoted.
    if (!me || watching) return;
    if (sessionRunning && endCapture) endCapture();
  }, [me, watching, sessionRunning, endCapture]);

  /**
   * The call the office should drop everything for right now. Test calls
   * flash nobody, and an outbound call is the office phoning out — not news.
   */
  const visibleLiveIncoming = watching
    ? ringingIncomingCall(calls ?? [], seen)
    : null;
  const liveWho =
    visibleLiveIncoming?.callerName ||
    visibleLiveIncoming?.callerPhone ||
    "Customer";
  const liveId = visibleLiveIncoming?.id ?? null;

  /**
   * Flash the browser tab while the phone rings. The dispatcher living in
   * their email is exactly who "I didn't know we got a call" comes from,
   * and a flashing tab title reaches them without any permission prompt.
   */
  const baseTitle = useRef<string | null>(null);
  useEffect(() => {
    if (liveId === null) return;
    if (baseTitle.current === null) baseTitle.current = document.title;
    let showAlert = true;
    const tick = () => {
      document.title = showAlert
        ? `📞 ${liveWho} connected to receptionist…`
        : (baseTitle.current ?? "");
      showAlert = !showAlert;
    };
    tick();
    const timer = setInterval(tick, 1200);
    return () => {
      clearInterval(timer);
      if (baseTitle.current !== null) {
        document.title = baseTitle.current;
        baseTitle.current = null;
      }
    };
  }, [liveId, liveWho]);

  /**
   * The moment the caller hangs up, a phone falls silent. Starting the ring
   * belongs to the announcement below (which already knows "new call, told
   * nobody yet, once per call"); ending it early belongs here, because only
   * the live list knows the call is over.
   */
  useEffect(() => {
    if (liveId === null) stopRinging();
  }, [liveId]);

  useEffect(() => {
    if (!watching || !calls || !session) return;

    if (primedFor !== session) {
      announced.clear();
      primed = false;
      primedFor = session;
    }

    if (!primed) {
      for (const call of calls) announced.add(call.id);
      primed = true;
      /**
       * A call that is ringing the moment the page loads is not history —
       * it's the call the dispatcher opened the dashboard *for*. It gets no
       * toast (the list on screen already shows it), but capture must start
       * exactly as if it had rung a second after load, or the microphone
       * only ever works for calls that arrive while someone is already
       * looking. startForCall keeps its own rules: it only starts by itself
       * when the microphone is already granted, and otherwise raises the
       * one-tap prompt.
       */
      const liveAtLoad = calls.find((c) => c.status === "in_progress");
      if (
        capture &&
        liveAtLoad &&
        shouldTakeOverCapture(
          capture.capturingCallId,
          liveAtLoad.id,
          capture.transcript.listening,
        )
      ) {
        capture.startForCall(liveAtLoad.id);
      }
      return;
    }

    const fresh = callsWorthAnnouncing(calls, Date.now()).filter(
      (call) => !announced.has(call.id),
    );
    // Mark everything seen even when we stay quiet, so leaving the booking
    // desk doesn't dump a backlog of popups.
    for (const call of calls) announced.add(call.id);
    if (fresh.length === 0) return;

    // Only one toast is on screen at a time, so lead with the newest.
    const call = fresh[0]!;

    /**
     * Start listening even when the dispatcher is on the booking desk (which
     * skips the toast): the point of catching the first sentence is that it
     * happens before anyone reacts to anything.
     */
    if (
      capture &&
      call.status === "in_progress" &&
      shouldTakeOverCapture(
        capture.capturingCallId,
        call.id,
        capture.transcript.listening,
      )
    ) {
      capture.startForCall(call.id);
    } else if (
      capture &&
      call.status === "in_progress" &&
      capture.transcript.listening &&
      capture.capturingCallId !== null &&
      capture.capturingCallId !== call.id
    ) {
      // The takeover guard said no because another call holds the
      // microphone. That's the right call, but it must not be a silent one.
      capture.noteDecline("busy-other-call");
    }

    const who = call.callerName || call.callerPhone || "Unknown caller";
    const ringing = call.status === "in_progress";
    const title = ringing ? `${who} is calling` : `${who} called`;
    const body =
      call.serviceRequested ||
      (ringing ? "On the line now." : "Just came off the phone.");

    /**
     * Sound and the desktop pop-up fire wherever the dispatcher is, booking
     * desk included: sitting on that page with the window behind their email
     * is exactly the case a toast can't reach. A ringing call rings like a
     * phone — repeating, across page changes, in a background tab, until
     * it's reacted to or the call ends — because one polite ding was
     * exactly what "I didn't hear it" was made of. A call that already
     * ended keeps the single alert sound. The announcement fires once per
     * call, so the ring can't restart itself on the next poll.
     */
    if (capture?.soundOn !== false) {
      if (ringing) startRinging();
      else playCallAlert();
    }
    popUp({
      title,
      body,
      // One notification per call, replaced rather than stacked while it rings.
      tag: `call-${call.id}`,
      onClick: () => navigate(`/bookings/new?callId=${call.id}`),
    });

    /**
     * The phone ringing opens the booking desk by itself — the owner asked
     * for exactly this: wherever he is in the app, the form is on screen
     * with the call loaded before he touches anything. The one place it
     * won't barge into is the desk itself, where someone may be mid-way
     * through typing up a different booking.
     */
    if (ringing && !onBookingDesk) {
      navigate(`/bookings/new?callId=${call.id}`);
      // The desk now shows this exact call; a toast would only repeat it.
      return;
    }

    // The desk already shows the call it is working on, so a toast there is
    // one more thing to dismiss and no more information.
    if (onBookingDesk) return;

    toast({
      title,
      description: body,
      action: (
        <ToastAction
          altText="Open this call in the booking desk"
          onClick={() => navigate(`/bookings/new?callId=${call.id}`)}
        >
          Take booking
        </ToastAction>
      ),
    });
  }, [calls, watching, session, onBookingDesk, toast, navigate, capture]);

  // The unmissable part: a flashing red bar across the top of every page
  // while the phone is ringing. The booking desk is spared — the dispatcher
  // there is already dealing with this exact call.
  if (!visibleLiveIncoming || onBookingDesk) return null;

  const dismiss = () => {
    const nextSeen = new Set(seen ?? []);
    nextSeen.add(visibleLiveIncoming.id);
    markSeen(visibleLiveIncoming.id);
    if (!ringingIncomingCall(calls ?? [], nextSeen)) stopRinging();
  };

  return (
    <div
      className="fixed top-0 inset-x-0 z-[9999]"
      data-testid="banner-incoming-call"
    >
      <div className="animate-pulse flex items-center justify-center gap-3 bg-red-600 text-white px-4 py-2.5 shadow-lg">
        <Phone className="w-4 h-4 shrink-0" />
        <span className="text-sm font-semibold truncate">
          {liveWho} is currently connected to the receptionist
          {visibleLiveIncoming.serviceRequested
            ? ` — ${visibleLiveIncoming.serviceRequested}`
            : ""}
        </span>
        <button
          type="button"
          onClick={() =>
            navigate(`/bookings/new?callId=${visibleLiveIncoming.id}`)
          }
          className="shrink-0 rounded-md bg-white text-red-700 hover:bg-red-50 text-xs font-bold px-3 py-1"
          data-testid="button-take-call"
        >
          Take booking
        </button>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded-md border border-white/70 px-3 py-1 text-xs font-bold text-white hover:bg-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-red-600"
          data-testid="button-dismiss-incoming-call"
          aria-label="Dismiss alert for this customer connected to the receptionist"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
