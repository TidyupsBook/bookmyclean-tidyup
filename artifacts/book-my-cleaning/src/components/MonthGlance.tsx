/**
 * "What have you got that week?"
 *
 * The caller asks it on nearly every call, and until now the answer meant
 * leaving the booking, opening the schedule, and coming back to a form the
 * microphone had moved on from. So the month sits on the booking desk itself:
 * small, read-mostly, one number per day.
 *
 * Tapping a day pins the booking there — the same thing the dispatcher was
 * about to type into the date box, minus the typing. Nothing else is
 * clickable; this is a glance, not the schedule page.
 */
import { useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import {
  useListBookingsInRange,
  getListBookingsInRangeQueryKey,
} from "@workspace/api-client-react";
import {
  monthGridDates,
  monthLabel,
  shiftMonth,
  dayNumber,
  groupByDay,
  zonedClock,
} from "@/lib/mapCalendar";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

export function MonthGlance({
  timeZone,
  today,
  selectedDate,
  onPickDate,
}: {
  timeZone: string;
  /** Today in the company's zone — the caller's today, not the browser's. */
  today: string;
  /** The date on the booking form, or "" while it is still undecided. */
  selectedDate: string;
  onPickDate: (date: string) => void;
}) {
  const [anchor, setAnchor] = useState(
    () => `${(selectedDate || today).slice(0, 7)}-01`,
  );

  const dates = useMemo(() => monthGridDates(anchor), [anchor]);
  const rangeParams = useMemo(
    () => ({ start: dates[0]!, end: dates[dates.length - 1]! }),
    [dates],
  );
  const { data } = useListBookingsInRange(rangeParams, {
    query: { queryKey: getListBookingsInRangeQueryKey(rangeParams) },
  });

  const byDay = useMemo(
    () => groupByDay(data?.bookings ?? [], timeZone),
    [data, timeZone],
  );

  const month = anchor.slice(0, 7);
  // What the strip underneath talks about: the day being booked while there is
  // one, otherwise today — so the box is never blank.
  const focusDate = selectedDate || today;
  const focusJobs = [...(byDay[focusDate] ?? [])].sort((a, b) =>
    a.scheduledFor.localeCompare(b.scheduledFor),
  );

  return (
    <section
      className="bg-card border border-border rounded-xl shadow-sm overflow-hidden flex flex-col min-w-0"
      data-testid="month-glance"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <CalendarDays className="w-4 h-4 text-brand-pink shrink-0" />
          <h3 className="text-sm font-semibold text-foreground truncate">
            {monthLabel(anchor)}
          </h3>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setAnchor(shiftMonth(anchor, -1))}
            className="p-1 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            aria-label="Previous month"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setAnchor(shiftMonth(anchor, 1))}
            className="p-1 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            aria-label="Next month"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 px-1 pt-1">
        {WEEKDAYS.map((d, i) => (
          <div
            key={`${d}${i}`}
            className="text-center text-[10px] font-semibold uppercase text-muted-foreground"
          >
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-0.5 p-1">
        {dates.map((date) => {
          const jobs = byDay[date] ?? [];
          const outside = date.slice(0, 7) !== month;
          const selected = date === selectedDate;
          const isToday = date === today;
          return (
            <button
              key={date}
              type="button"
              onClick={() => onPickDate(date)}
              aria-pressed={selected}
              aria-label={`${date}, ${jobs.length} job${jobs.length === 1 ? "" : "s"}`}
              data-testid={`glance-day-${date}`}
              className={cn(
                "rounded-md py-1 text-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "brand-gradient text-white"
                  : outside
                    ? "text-muted-foreground/40 hover:bg-secondary/60"
                    : "text-foreground hover:bg-secondary",
                !selected && isToday && "ring-1 ring-brand-purple/50",
              )}
            >
              <span className="block text-xs font-semibold leading-none">
                {dayNumber(date)}
              </span>
              <span
                className={cn(
                  "block text-[10px] leading-none mt-0.5 tabular-nums",
                  selected ? "text-white/90" : "text-muted-foreground",
                )}
              >
                {jobs.length > 0 ? jobs.length : "\u00A0"}
              </span>
            </button>
          );
        })}
      </div>

      {/* The day being booked, spelled out — a count alone doesn't tell you
          whether the morning is free. */}
      <div
        className="border-t border-border px-3 py-2 text-xs"
        data-testid="glance-focus-day"
      >
        {focusJobs.length === 0 ? (
          <span className="text-muted-foreground">
            Nothing booked {focusDate === today ? "today" : "that day"} yet.
          </span>
        ) : (
          <div className="space-y-0.5">
            {focusJobs.slice(0, 3).map((job) => (
              <div key={job.bookingId} className="flex gap-2 truncate">
                <span className="text-muted-foreground tabular-nums shrink-0">
                  {zonedClock(job.scheduledFor, timeZone)}
                </span>
                <span className="text-foreground truncate">
                  {job.customerName}
                </span>
              </div>
            ))}
            {focusJobs.length > 3 && (
              <div className="text-muted-foreground">
                +{focusJobs.length - 3} more
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
