import { Loader2, Mic, MicOff, Pause, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { captureStatusLabel, formatElapsed } from "@/lib/speech";
import { listeningHint, type CallCapture } from "@/lib/callCapture";

/**
 * The status line and the four controls, shared by the booking desk and the
 * floating banner.
 *
 * They are one component on purpose. A dispatcher who pauses from the banner
 * and then walks to the desk must find the same session in the same state,
 * with the same buttons — two hand-written copies of this drifted apart the
 * moment either one changed.
 */

/**
 * Which of Listening / Paused / Reconnecting / Stopped it is in, why it
 * stopped if it stopped, and how long it has been listening.
 */
export function CaptureStatusLine({
  capture,
  className,
}: {
  capture: CallCapture;
  className?: string;
}) {
  const { transcript, callLooksOver } = capture;
  const { status } = transcript;
  const showClock =
    status === "listening" || status === "reconnecting" || status === "paused";

  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-center gap-2 text-sm">
        {status === "starting" ? (
          <Loader2 className="w-3.5 h-3.5 text-brand-pink animate-spin shrink-0" />
        ) : (
          <span
            className={cn(
              "w-2 h-2 rounded-full shrink-0",
              status === "listening" && "bg-green-400 animate-pulse",
              status === "reconnecting" && "bg-amber-400 animate-pulse",
              status === "paused" && "bg-amber-400",
              (status === "stopped" || status === "idle") &&
                "bg-muted-foreground/50",
            )}
          />
        )}
        <span
          className="font-medium text-foreground"
          data-testid="text-capture-status"
        >
          {captureStatusLabel(status)}
        </span>
        {showClock && (
          <span
            className="text-muted-foreground tabular-nums"
            data-testid="text-capture-elapsed"
          >
            {formatElapsed(transcript.elapsedMs)}
          </span>
        )}
      </div>

      {status === "listening" && !transcript.quiet && (
        <p className="text-sm text-muted-foreground">
          {listeningHint(capture.micMode)}
        </p>
      )}

      {status === "reconnecting" && (
        <p className="text-sm text-amber-500">
          The connection dropped — picking the words back up. Nothing already
          heard is lost.
        </p>
      )}

      {status === "paused" && (
        <p className="text-sm text-muted-foreground">
          Paused — every word so far is kept. Resume carries on from here.
        </p>
      )}

      {(status === "stopped" || status === "idle") && transcript.stopReason && (
        <p
          className="text-sm text-muted-foreground"
          data-testid="text-capture-stop-reason"
        >
          {transcript.stopReason}
        </p>
      )}

      {/**
       * The call list thinks the call is over. Said, never acted on: Quo
       * moves a call off "in progress" while the two people are still
       * talking, so this is a nudge and the Stop button is right there.
       */}
      {callLooksOver && transcript.active && (
        <p
          className="text-sm text-amber-500"
          data-testid="text-call-looks-over"
        >
          This call looks finished — stop when you're done.
        </p>
      )}
    </div>
  );
}

/**
 * Pause / Resume / Restart / Stop, or Start listening when nothing is running.
 * Same set wherever the dispatcher is standing.
 */
export function CaptureControls({
  capture,
  callId,
  className,
}: {
  capture: CallCapture;
  /** The call a fresh start should follow, when there is one. */
  callId?: number | null;
  className?: string;
}) {
  const { transcript } = capture;
  const { status } = transcript;
  const running = status === "listening" || status === "reconnecting";
  const idle = status === "idle" || status === "stopped";

  return (
    <div className={cn("flex items-center gap-2 flex-wrap", className)}>
      {status === "starting" && (
        <Button size="sm" disabled data-testid="button-capture-starting">
          <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
          Starting…
        </Button>
      )}

      {running && (
        <Button
          size="sm"
          variant="secondary"
          onClick={capture.pauseCapture}
          data-testid="button-capture-pause"
        >
          <Pause className="w-4 h-4 mr-1.5" />
          Pause
        </Button>
      )}

      {status === "paused" && (
        <Button
          size="sm"
          onClick={capture.resumeCapture}
          data-testid="button-capture-resume"
        >
          <Play className="w-4 h-4 mr-1.5" />
          Resume
        </Button>
      )}

      {idle ? (
        <Button
          size="sm"
          onClick={() => capture.startManually(callId ?? null)}
          data-testid="button-capture-start"
        >
          <Mic className="w-4 h-4 mr-1.5" />
          Start listening
        </Button>
      ) : (
        <>
          <Button
            size="sm"
            variant="secondary"
            onClick={capture.restartCapture}
            data-testid="button-capture-restart"
          >
            <RotateCcw className="w-4 h-4 mr-1.5" />
            Restart
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={capture.endCapture}
            data-testid="button-capture-stop"
          >
            <MicOff className="w-4 h-4 mr-1.5" />
            Stop
          </Button>
        </>
      )}
    </div>
  );
}
