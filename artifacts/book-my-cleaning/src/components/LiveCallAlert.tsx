import { useEffect } from "react";
import { useLocation } from "wouter";
import {
  useListCalls,
  getListCallsQueryKey,
  useGetCurrentUser,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { callsWorthAnnouncing } from "@/lib/callAlerts";

/**
 * Tells whoever is on dispatch that the phone just rang, wherever they happen
 * to be in the app, and hands them a one-click way into the booking desk with
 * that call already loaded.
 *
 * Before this, a call was only visible to someone already sitting on the Calls
 * page or the booking desk. Anyone looking at the map or the schedule missed
 * it entirely, which is the moment that matters most.
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

  // Crew never see caller details, and the booking desk is already watching
  // its own call, so neither needs a popup about it.
  const watching = me?.role === "owner" || me?.role === "dispatcher";
  const onBookingDesk = location.startsWith("/bookings/new");

  // The booking desk runs its own poll on the same list, so stepping aside
  // there keeps this from doubling the traffic for no extra news.
  const { data: calls } = useListCalls(undefined, {
    query: {
      queryKey: getListCallsQueryKey(undefined),
      refetchInterval: watching && !onBookingDesk ? POLL_MS : false,
      enabled: watching,
    },
  });

  const session = me ? `${me.email}@${me.companyName}` : null;

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
      return;
    }

    const fresh = callsWorthAnnouncing(calls, Date.now()).filter(
      (call) => !announced.has(call.id),
    );
    // Mark everything seen even when we stay quiet, so leaving the booking
    // desk doesn't dump a backlog of popups.
    for (const call of calls) announced.add(call.id);
    if (onBookingDesk || fresh.length === 0) return;

    // Only one toast is on screen at a time, so lead with the newest.
    const call = fresh[0]!;
    const who = call.callerName || call.callerPhone || "Unknown caller";
    toast({
      title:
        call.status === "in_progress" ? `${who} is calling` : `${who} called`,
      description:
        call.serviceRequested ||
        (call.status === "in_progress"
          ? "On the line now."
          : "Just came off the phone."),
      action: (
        <ToastAction
          altText="Open this call in the booking desk"
          onClick={() => navigate(`/bookings/new?callId=${call.id}`)}
        >
          Take booking
        </ToastAction>
      ),
    });
  }, [calls, watching, session, onBookingDesk, toast, navigate]);

  return null;
}
