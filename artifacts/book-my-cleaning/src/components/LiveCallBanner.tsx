import { useLocation } from "wouter";
import { Mic, ArrowRight } from "lucide-react";
import { useGetCurrentUser } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  declineMessage,
  quietMicMessage,
  useCallCapture,
} from "@/lib/callCapture";
import { liveCallBarBusy } from "@/lib/cornerStack";
import {
  CaptureControls,
  CaptureStatusLine,
} from "@/components/CaptureControls";

/**
 * A standing reminder that the microphone is on and words are being caught,
 * shown wherever the dispatcher happens to be.
 *
 * A toast was not enough for this: it disappears after a few seconds, and the
 * thing it is reporting lasts the length of a phone call. Someone needs to be
 * able to glance at the screen mid-sentence and see both that it's working and
 * the way into the form — and, just as importantly, take control of the
 * session from anywhere. Pause, Resume, Restart and Stop are all here, because
 * a dispatcher who has to navigate to the booking desk to pause the microphone
 * has already said the thing they didn't want typed in.
 *
 * Hidden on the booking desk, which shows the full panel already.
 */
export function LiveCallBanner() {
  const [location, navigate] = useLocation();
  const capture = useCallCapture();
  const { data: me } = useGetCurrentUser();
  // The microphone banner belongs to whoever may take live calls — the owner,
  // or a dispatcher with the live-call dispatching switch on their card.
  // Positive check: while the flag is still loading nothing is shown, rather
  // than flashing a control that leads to a form the server would refuse.
  if (me?.canTakeLiveCalls !== true) return null;
  if (!capture) return null;
  if (location.startsWith("/bookings/new")) return null;

  const { transcript, capturingCallId, needsPermission, declined } = capture;
  const busy = transcript.active;
  // A named decline is shown even while idle: "why didn't it start?" is the
  // one question this banner exists to answer. The shared corner predicate
  // decides which states count, so this bar and the Live booking launcher
  // can never both claim the corner — in particular, an `unsupported`
  // decline no longer raises the bar at all: on an iPad every ring would,
  // and the launcher (plus the desk's own notice) is that device's path.
  if (!liveCallBarBusy(capture)) return null;

  const openDesk = () =>
    navigate(
      capturingCallId
        ? `/bookings/new?callId=${capturingCallId}`
        : "/bookings/new",
    );

  const tail = transcript.interim || transcript.text;

  return (
    <div
      data-testid="banner-live-call"
      className="fixed bottom-4 right-4 z-50 w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-brand-pink/40 bg-card/95 backdrop-blur shadow-lg p-4 space-y-3"
    >
      {busy ? (
        <CaptureStatusLine capture={capture} />
      ) : (
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-muted-foreground/50" />
          <span className="text-sm font-semibold text-foreground">
            {needsPermission
              ? "The phone is ringing"
              : "Call capture didn't start"}
          </span>
        </div>
      )}

      {needsPermission && !busy ? (
        <p className="text-sm text-muted-foreground">
          Allow the microphone once and every call after this one starts typing
          itself into the booking form.
        </p>
      ) : declined && !busy ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="text-capture-declined"
        >
          {declined === "start-failed" && transcript.error
            ? transcript.error
            : declineMessage(declined)}
        </p>
      ) : transcript.quiet ? (
        /**
         * On speaker a silent microphone is a fault worth amber. On earbuds
         * it is the customer's turn to talk — the reminder is the repeat-back
         * habit, in the ordinary muted voice, never a speakerphone nag.
         */
        <p
          className={
            capture.micMode === "earbuds"
              ? "text-sm text-muted-foreground"
              : "text-sm text-amber-500"
          }
        >
          {quietMicMessage(capture.micMode)}
        </p>
      ) : tail ? (
        <p className="text-sm text-muted-foreground line-clamp-2">{tail}</p>
      ) : (
        <p className="text-sm text-muted-foreground italic">
          Waiting for the first words…
        </p>
      )}

      {busy && transcript.error && (
        <p className="text-sm text-destructive">{transcript.error}</p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" onClick={openDesk} data-testid="button-open-desk">
          Take booking
          <ArrowRight className="w-4 h-4 ml-1.5" />
        </Button>
        {busy ? (
          <CaptureControls capture={capture} callId={capturingCallId} />
        ) : (
          declined !== "unsupported" && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => capture.startManually(capturingCallId)}
              data-testid="button-start-listening"
            >
              <Mic className="w-4 h-4 mr-1.5" />
              Start listening
            </Button>
          )
        )}
        {declined && !busy && (
          <Button
            size="sm"
            variant="ghost"
            onClick={capture.clearDecline}
            data-testid="button-dismiss-decline"
          >
            Dismiss
          </Button>
        )}
      </div>
    </div>
  );
}
