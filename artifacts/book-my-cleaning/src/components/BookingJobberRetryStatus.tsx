import type { Booking } from "@workspace/api-client-react";
import { Clock3, Hand } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

function remainingLabel(remaining: number): string {
  return `${remaining} automatic ${remaining === 1 ? "retry" : "retries"} remaining`;
}

export function BookingJobberRetryStatus({
  booking,
  testId,
}: {
  booking: Booking;
  testId?: string;
}) {
  const status = booking.jobberAutomaticRetryStatus;
  if (!status || status === "none") return null;

  if (status === "pending") {
    const nextRetryAt = booking.jobberNextRetryAt
      ? new Date(booking.jobberNextRetryAt)
      : null;
    const nextRetryLabel =
      nextRetryAt && Number.isFinite(nextRetryAt.getTime())
        ? nextRetryAt.getTime() <= Date.now()
          ? "Automatic retry is due now"
          : `Next automatic retry ${formatDistanceToNow(nextRetryAt, {
              addSuffix: true,
            })}`
        : "Automatic retry is pending";

    return (
      <div
        className="rounded-md border border-amber-800 bg-amber-950/40 px-3 py-2 text-xs text-amber-300"
        data-testid={testId ?? `jobber-retry-status-${booking.id}`}
      >
        <div className="flex items-start gap-2">
          <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            <div className="font-medium">Automatic retry pending</div>
            <div className="mt-0.5 text-amber-300/75">
              {booking.jobberAutomaticRetriesRemaining !== null
                ? `${remainingLabel(booking.jobberAutomaticRetriesRemaining)} · `
                : ""}
              {nextRetryLabel}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-md border border-orange-800 bg-orange-950/40 px-3 py-2 text-xs text-orange-300"
      data-testid={testId ?? `jobber-retry-status-${booking.id}`}
    >
      <div className="flex items-start gap-2">
        <Hand className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div>
          <div className="font-medium">
            {status === "exhausted"
              ? "Automatic retries exhausted"
              : "Manual retry needed"}
          </div>
          <div className="mt-0.5 text-orange-300/75">
            {status === "exhausted"
              ? "0 automatic retries remaining. Use Sync to Jobber below."
              : "Automatic retries stopped. Retry the Jobber action manually."}
          </div>
        </div>
      </div>
    </div>
  );
}
