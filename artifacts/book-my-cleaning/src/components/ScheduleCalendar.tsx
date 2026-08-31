/**
 * The month and week boards on the Schedule page.
 *
 * These are the "everything at once" views: every visit in the span, coloured
 * by whoever is on it. They are deliberately bigger and busier than the little
 * calendar above the live map — that one is a date picker, this one is the
 * schedule itself.
 *
 * Every time here is drawn in the *company's* timezone. A block's position and
 * its label both come from that zone, never the browser clock, so a dispatcher
 * working from another city sees the hour the customer was promised.
 */
import { useMemo } from "react";
import type { BookingRangeItem } from "@workspace/api-client-react";
import { colorForTeamMember } from "@/lib/mapMarkers";
import {
  GRID_START_HOUR,
  GRID_END_HOUR,
  dayNumber,
  weekdayShort,
  zonedClock,
  zonedHour,
} from "@/lib/mapCalendar";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Pixels per hour in the week grid. Tall enough to read a two-line block. */
const HOUR_PX = 56;

/** Chips a month cell shows before it collapses the rest into "+N more". */
const MONTH_CHIP_LIMIT = 3;

export type BookingsByDay = Record<string, BookingRangeItem[]>;

/**
 * Unassigned work is what a dispatcher is hunting for, so it keeps the brand
 * pink instead of blending into the crew colours.
 */
function crewColor(booking: BookingRangeItem): string {
  const first = booking.assignees[0];
  return first
    ? colorForTeamMember(first.teamMemberId, first.color)
    : "hsl(330, 81%, 60%)";
}

function crewLabel(booking: BookingRangeItem): string {
  if (booking.assignees.length === 0) return "Needs a crew";
  return booking.assignees.map((a) => a.name).join(", ");
}

function blockTitle(booking: BookingRangeItem, timeZone: string): string {
  return [
    zonedClock(booking.scheduledFor, timeZone),
    booking.customerName,
    booking.service,
    crewLabel(booking),
  ].join(" · ");
}

/**
 * Cancelled work stays on the board, struck through, rather than vanishing.
 * Completed work stays too, dimmed — a done job reads as a shadow of itself
 * so the calendar shows what's left at a glance.
 */
function cancelledStyle(booking: BookingRangeItem) {
  if (booking.status === "canceled")
    return { opacity: 0.5, textDecoration: "line-through" as const };
  if (booking.status === "completed") return { opacity: 0.55 };
  return {};
}

/** Does this visit belong to the highlighted cleaner? */
export function isHighlighted(
  booking: BookingRangeItem,
  highlight: number | null | undefined,
): boolean {
  return (
    highlight != null &&
    booking.assignees.some((a) => a.teamMemberId === highlight)
  );
}

/**
 * When a cleaner is highlighted from the roster strip, everyone else's blocks
 * fade back so their work reads at a glance. Applied after cancelledStyle so
 * the dim wins even on a struck-through block.
 */
function highlightStyle(
  booking: BookingRangeItem,
  highlight: number | null | undefined,
) {
  if (highlight == null) return {};
  return isHighlighted(booking, highlight)
    ? {}
    : { opacity: 0.18, filter: "grayscale(0.5)" };
}

/* ─────────────────────────── Month ─────────────────────────── */

export function MonthBoard({
  monthAnchor,
  dates,
  today,
  bookingsByDay,
  timeZone,
  onOpenDay,
  onSelectBooking,
  highlight,
}: {
  monthAnchor: string;
  dates: string[];
  today: string;
  bookingsByDay: BookingsByDay;
  timeZone: string;
  onOpenDay: (date: string) => void;
  onSelectBooking: (bookingId: number) => void;
  /** Team member whose visits stay full-strength while the rest dim. */
  highlight?: number | null;
}) {
  const month = monthAnchor.slice(0, 7);

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="grid grid-cols-7 border-b border-border bg-secondary/30">
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            className="py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {dates.map((date) => {
          const visits = bookingsByDay[date] ?? [];
          const outside = date.slice(0, 7) !== month;
          const isToday = date === today;
          const shown = visits.slice(0, MONTH_CHIP_LIMIT);
          const hidden = visits.length - shown.length;

          return (
            <div
              key={date}
              className={[
                "min-h-[7.5rem] border-r border-b border-border/60 p-1.5 flex flex-col gap-1",
                outside ? "bg-background/40" : "",
              ].join(" ")}
            >
              <div className="flex items-center justify-between gap-1">
                <button
                  type="button"
                  onClick={() => onOpenDay(date)}
                  className={[
                    "inline-flex items-center justify-center min-w-6 h-6 px-1.5 rounded-full text-xs font-semibold transition-colors",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isToday
                      ? "brand-gradient text-white"
                      : outside
                        ? "text-muted-foreground/50 hover:bg-secondary"
                        : "text-foreground hover:bg-secondary",
                  ].join(" ")}
                  aria-label={`Open ${date}, ${visits.length} ${
                    visits.length === 1 ? "visit" : "visits"
                  }`}
                >
                  {dayNumber(date)}
                </button>
                {visits.length > 0 && (
                  <span className="text-[10px] text-muted-foreground">
                    {visits.length} {visits.length === 1 ? "visit" : "visits"}
                  </span>
                )}
              </div>

              {shown.map((booking) => (
                <button
                  key={booking.bookingId}
                  type="button"
                  onClick={() => onSelectBooking(booking.bookingId)}
                  data-testid={`chip-booking-${booking.bookingId}`}
                  className="block w-full text-left rounded px-1.5 py-1 text-[11px] leading-tight text-white overflow-hidden hover:brightness-110 transition-[filter]"
                  style={{
                    background: crewColor(booking),
                    ...cancelledStyle(booking),
                    ...highlightStyle(booking, highlight),
                  }}
                  title={blockTitle(booking, timeZone)}
                >
                  <div className="truncate font-semibold">
                    {zonedClock(booking.scheduledFor, timeZone)}{" "}
                    {booking.customerName}
                  </div>
                  <div className="truncate opacity-90">{booking.service}</div>
                </button>
              ))}

              {hidden > 0 && (
                <button
                  type="button"
                  onClick={() => onOpenDay(date)}
                  className="text-left text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  +{hidden} more
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────────────────────── Week ─────────────────────────── */

export function WeekBoard({
  dates,
  today,
  bookingsByDay,
  timeZone,
  onOpenDay,
  onSelectBooking,
  highlight,
}: {
  dates: string[];
  today: string;
  bookingsByDay: BookingsByDay;
  timeZone: string;
  onOpenDay: (date: string) => void;
  onSelectBooking: (bookingId: number) => void;
  /** Team member whose visits stay full-strength while the rest dim. */
  highlight?: number | null;
}) {
  const hours = useMemo(
    () =>
      Array.from(
        { length: GRID_END_HOUR - GRID_START_HOUR + 1 },
        (_, i) => GRID_START_HOUR + i,
      ),
    [],
  );
  const gridHeight = (GRID_END_HOUR - GRID_START_HOUR + 1) * HOUR_PX;
  const columns = `56px repeat(${dates.length}, minmax(0, 1fr))`;

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
      <div
        className="grid border-b border-border bg-secondary/30"
        style={{ gridTemplateColumns: columns }}
      >
        <div />
        {dates.map((date) => {
          const count = (bookingsByDay[date] ?? []).length;
          return (
            <button
              key={date}
              type="button"
              onClick={() => onOpenDay(date)}
              className="py-2 px-1 text-center border-l border-border/60 hover:bg-secondary transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {weekdayShort(date)}
              </div>
              <div
                className={[
                  "text-base font-semibold",
                  date === today ? "text-brand-pink" : "text-foreground",
                ].join(" ")}
              >
                {dayNumber(date)}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {count > 0
                  ? `${count} ${count === 1 ? "visit" : "visits"}`
                  : "—"}
              </div>
            </button>
          );
        })}
      </div>

      <div className="overflow-y-auto max-h-[36rem]">
        <div
          className="grid relative"
          style={{ gridTemplateColumns: columns, height: gridHeight }}
        >
          <div className="relative">
            {hours.map((h, i) => (
              <div
                key={h}
                className="absolute right-2 -translate-y-1/2 text-[11px] text-muted-foreground tabular-nums"
                style={{ top: i * HOUR_PX }}
              >
                {formatHour(h)}
              </div>
            ))}
          </div>

          {dates.map((date) => (
            <div key={date} className="relative border-l border-border/60">
              {hours.map((h, i) => (
                <div
                  key={h}
                  className="absolute left-0 right-0 border-t border-border/40"
                  style={{ top: i * HOUR_PX }}
                />
              ))}
              {(bookingsByDay[date] ?? []).map((booking, index) => (
                <WeekBlock
                  key={booking.bookingId}
                  booking={booking}
                  index={index}
                  timeZone={timeZone}
                  onSelect={onSelectBooking}
                  highlight={highlight}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function WeekBlock({
  booking,
  index,
  timeZone,
  onSelect,
  highlight,
}: {
  booking: BookingRangeItem;
  index: number;
  timeZone: string;
  onSelect: (bookingId: number) => void;
  highlight?: number | null;
}) {
  const hour = zonedHour(booking.scheduledFor, timeZone);
  // Clamp so a very early or very late job still shows at the edge of the grid
  // instead of scrolling out of sight entirely.
  const start = Math.min(Math.max(hour, GRID_START_HOUR), GRID_END_HOUR);
  const top = (start - GRID_START_HOUR) * HOUR_PX;
  // A block is as tall as the job is long, but never so short it can't be read
  // and never so long it runs off the bottom of the grid.
  const hoursLong = booking.durationMinutes / 60;
  const maxHours = GRID_END_HOUR + 1 - start;
  const height = Math.max(26, Math.min(hoursLong, maxHours) * HOUR_PX - 4);

  return (
    <button
      type="button"
      onClick={() => onSelect(booking.bookingId)}
      data-testid={`block-booking-${booking.bookingId}`}
      className="absolute text-left rounded-md px-1.5 py-1 text-[11px] leading-tight text-white overflow-hidden shadow-sm hover:brightness-110 transition-[filter]"
      style={{
        top: top + 1,
        height,
        // Overlapping jobs fan out slightly rather than hiding each other.
        left: 3 + index * 4,
        right: 3,
        background: crewColor(booking),
        ...cancelledStyle(booking),
        ...highlightStyle(booking, highlight),
      }}
      title={blockTitle(booking, timeZone)}
    >
      <div className="font-semibold truncate">
        {zonedClock(booking.scheduledFor, timeZone)} {booking.customerName}
      </div>
      <div className="truncate opacity-90">{booking.service}</div>
      <div className="truncate opacity-80">{crewLabel(booking)}</div>
    </button>
  );
}

function formatHour(hour: number): string {
  const suffix = hour >= 12 ? "pm" : "am";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${suffix}`;
}
