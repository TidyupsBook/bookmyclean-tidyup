import { useEffect, useState } from "react";
import {
  useStartBookingTimer,
  useStopBookingTimer,
  useUpdateBooking,
  getListBookingsQueryKey,
  type Booking,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Play, Square, Timer } from "lucide-react";
import {
  elapsedSeconds,
  formatStopwatch,
  formatWorkedTime,
  jobberMinutes,
  totalMinutesSoFar,
  workedHours,
} from "@/lib/jobTimer";

/**
 * The on-site clock, as it appears on a job card.
 *
 * Crew tap this on their phone at the house, so the running state has to be
 * unmistakable at arm's length — a green panel with seconds moving, and one
 * button. The office sees the same panel plus the one thing crew must never
 * see: what those hours would be worth on the quote.
 */
export function JobTimerPanel({
  booking,
  canDispatch,
}: {
  booking: Booking;
  canDispatch: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const startTimer = useStartBookingTimer();
  const stopTimer = useStopBookingTimer();
  const updateBooking = useUpdateBooking();

  const running = booking.timerRunningSince ?? null;
  const [now, setNow] = useState(() => Date.now());

  // Only tick while something is actually running — an idle bookings page
  // should not re-render every card once a second.
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getListBookingsQueryKey() });

  const banked = booking.workedMinutes ?? 0;
  const total = totalMinutesSoFar(banked, running, now);
  const fromJobber = jobberMinutes(booking.timeEntries);
  const hours = workedHours(total);
  const busy = startTimer.isPending || stopTimer.isPending;

  const handleStart = () =>
    startTimer.mutate(
      { id: booking.id },
      {
        onSuccess: () => {
          setNow(Date.now());
          void refresh();
        },
        onError: (error: any) =>
          toast({
            title: "Couldn't start the clock",
            description:
              error?.message || "Check your signal and tap Start again.",
            variant: "destructive",
          }),
      },
    );

  const handleStop = () =>
    stopTimer.mutate(
      { id: booking.id },
      {
        onSuccess: () => {
          void refresh();
          toast({
            title: "Clocked off",
            description: `${formatWorkedTime(total)} on this job.`,
          });
        },
        onError: (error: any) =>
          toast({
            title: "Couldn't stop the clock",
            description:
              error?.message || "Check your signal and tap Stop again.",
            variant: "destructive",
          }),
      },
    );

  const handleUseHours = () =>
    updateBooking.mutate(
      { id: booking.id, data: { quoteHours: hours } },
      {
        onSuccess: () => {
          void refresh();
          toast({
            title: `Quote set to ${hours} h`,
            description:
              "Open Send quote when you're ready to price it at the real time.",
          });
        },
        onError: (error: any) =>
          toast({
            title: "Couldn't use those hours",
            description: error?.message || "Try again.",
            variant: "destructive",
          }),
      },
    );

  return (
    <div
      className={`mt-5 pt-4 border-t border-border ${running ? "" : ""}`}
      data-testid={`panel-timer-${booking.id}`}
    >
      {running ? (
        <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-green-400">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-60" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-400" />
              </span>
              <span className="text-sm font-medium">On site</span>
              <span
                className="font-mono text-lg font-semibold tabular-nums"
                data-testid={`text-timer-${booking.id}`}
              >
                {formatStopwatch(elapsedSeconds(running, now))}
              </span>
            </div>
            <Button
              onClick={handleStop}
              disabled={busy}
              className="gap-2 bg-green-600 hover:bg-green-500 text-white"
              data-testid={`button-stop-timer-${booking.id}`}
            >
              <Square className="w-4 h-4" /> Stop job
            </Button>
          </div>
          {banked > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Earlier today: {formatWorkedTime(banked)} —{" "}
              {formatWorkedTime(total)} in total so far.
            </p>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Timer className="w-4 h-4 shrink-0" />
            {banked > 0 ? (
              <span data-testid={`text-worked-${booking.id}`}>
                Time on site:{" "}
                <span className="font-medium text-foreground">
                  {formatWorkedTime(banked)}
                </span>
                {/* Hours nobody pressed Start for need an explanation. */}
                {fromJobber > 0 && (
                  <span data-testid={`text-jobber-time-${booking.id}`}>
                    {" "}
                    · {formatWorkedTime(fromJobber)} clocked in Jobber
                  </span>
                )}
              </span>
            ) : (
              <span>Not started</span>
            )}
          </div>
          <Button
            variant={banked > 0 ? "outline" : "default"}
            onClick={handleStart}
            disabled={busy}
            className="gap-2"
            data-testid={`button-start-timer-${booking.id}`}
          >
            <Play className="w-4 h-4" />{" "}
            {banked > 0 ? "Start again" : "Start job"}
          </Button>
        </div>
      )}

      {/* What those hours are worth is the office's call, never the crew's. */}
      {canDispatch && total > 0 && (
        <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>
            Real time worked: {formatWorkedTime(total)} ({hours} h)
            {booking.quoteHours != null && (
              <> · quoted at {booking.quoteHours} h</>
            )}
          </span>
          <button
            type="button"
            onClick={handleUseHours}
            disabled={updateBooking.isPending || booking.quoteHours === hours}
            className="text-brand-pink hover:underline disabled:opacity-40 disabled:no-underline"
            data-testid={`button-use-hours-${booking.id}`}
          >
            {booking.quoteHours === hours ? "Quote matches" : `Use ${hours} h`}
          </button>
        </div>
      )}
    </div>
  );
}
