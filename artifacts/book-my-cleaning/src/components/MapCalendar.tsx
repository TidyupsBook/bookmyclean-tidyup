/**
 * The calendar that sits above the live map: a month grid, and a column grid
 * shared by the 3-day and week views.
 *
 * Every time shown here is rendered in the *company's* timezone. A block's
 * vertical position comes from `zonedHour`, never from the browser clock, so a
 * dispatcher in another city sees the job in the same slot the customer was
 * promised.
 */
import { useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { BookingRangeItem } from "@workspace/api-client-react";
import { colorForTeamMember } from "@/lib/mapMarkers";
import {
  GRID_START_HOUR,
  GRID_END_HOUR,
  dayNumber,
  monthLabel,
  weekdayShort,
  zonedClock,
  zonedHour,
} from "@/lib/mapCalendar";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOUR_PX = 52;

/** Bookings keyed by their company-local YYYY-MM-DD. */
export type BookingsByDay = Record<string, BookingRangeItem[]>;

function blockColor(booking: BookingRangeItem): string {
  const first = booking.assignees[0];
  // Unassigned work is the thing a dispatcher is hunting for, so it gets the
  // brand pink rather than blending into the crew colours.
  return first ? colorForTeamMember(first.teamMemberId) : "hsl(330, 81%, 60%)";
}

/* ─────────────────────────── Month ─────────────────────────── */

export function MonthCalendar({
  anchor,
  dates,
  selectedDate,
  today,
  bookingsByDay,
  onSelectDate,
  onShiftMonth,
}: {
  anchor: string;
  dates: string[];
  selectedDate: string;
  today: string;
  bookingsByDay: BookingsByDay;
  onSelectDate: (date: string) => void;
  onShiftMonth: (delta: number) => void;
}) {
  const month = anchor.slice(0, 7);

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <button
          type="button"
          onClick={() => onShiftMonth(-1)}
          className="p-1.5 rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          aria-label="Previous month"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <h3 className="text-sm font-semibold text-foreground">
          {monthLabel(anchor)}
        </h3>
        <button
          type="button"
          onClick={() => onShiftMonth(1)}
          className="p-1.5 rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          aria-label="Next month"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 border-b border-border">
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
          const jobs = bookingsByDay[date] ?? [];
          const outside = date.slice(0, 7) !== month;
          const selected = date === selectedDate;
          const isToday = date === today;
          return (
            <button
              key={date}
              type="button"
              onClick={() => onSelectDate(date)}
              aria-pressed={selected}
              aria-label={`${date}, ${jobs.length} job${jobs.length === 1 ? "" : "s"}`}
              className={[
                "relative h-20 border-r border-b border-border/60 p-1.5 text-left transition-colors",
                "last-of-type:border-r-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                selected
                  ? "brand-gradient text-white"
                  : outside
                    ? "text-muted-foreground/50 hover:bg-secondary/50"
                    : "text-foreground hover:bg-secondary",
              ].join(" ")}
            >
              <span
                className={[
                  "inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold",
                  !selected && isToday
                    ? "bg-brand-purple/20 text-brand-purple"
                    : "",
                ].join(" ")}
              >
                {dayNumber(date)}
              </span>
              {jobs.length > 0 && (
                <span
                  className={[
                    "absolute bottom-1.5 left-1.5 right-1.5 truncate text-[11px] font-medium",
                    selected ? "text-white/90" : "text-muted-foreground",
                  ].join(" ")}
                >
                  {jobs.length} job{jobs.length === 1 ? "" : "s"}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ───────────────────── 3-day and week columns ───────────────────── */

export function ColumnCalendar({
  dates,
  selectedDate,
  today,
  bookingsByDay,
  timeZone,
  onSelectDate,
}: {
  dates: string[];
  selectedDate: string;
  today: string;
  bookingsByDay: BookingsByDay;
  timeZone: string;
  onSelectDate: (date: string) => void;
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

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
      {/* Day headers, aligned to the hour gutter below. */}
      <div
        className="grid border-b border-border"
        style={{
          gridTemplateColumns: `56px repeat(${dates.length}, minmax(0, 1fr))`,
        }}
      >
        <div />
        {dates.map((date) => {
          const selected = date === selectedDate;
          const count = (bookingsByDay[date] ?? []).length;
          return (
            <button
              key={date}
              type="button"
              onClick={() => onSelectDate(date)}
              aria-pressed={selected}
              className={[
                "py-2 px-1 text-center border-l border-border/60 transition-colors",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                selected ? "brand-gradient text-white" : "hover:bg-secondary",
              ].join(" ")}
            >
              <div
                className={[
                  "text-[11px] uppercase tracking-wide",
                  selected ? "text-white/80" : "text-muted-foreground",
                ].join(" ")}
              >
                {weekdayShort(date)}
              </div>
              <div
                className={[
                  "text-base font-semibold",
                  selected
                    ? "text-white"
                    : date === today
                      ? "text-brand-purple"
                      : "text-foreground",
                ].join(" ")}
              >
                {dayNumber(date)}
              </div>
              <div
                className={[
                  "text-[10px]",
                  selected ? "text-white/80" : "text-muted-foreground",
                ].join(" ")}
              >
                {count > 0 ? `${count} job${count === 1 ? "" : "s"}` : "—"}
              </div>
            </button>
          );
        })}
      </div>

      <div className="overflow-y-auto max-h-[420px]">
        <div
          className="grid relative"
          style={{
            gridTemplateColumns: `56px repeat(${dates.length}, minmax(0, 1fr))`,
            height: gridHeight,
          }}
        >
          {/* Hour gutter */}
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
            <div
              key={date}
              className="relative border-l border-border/60"
              onDoubleClick={() => onSelectDate(date)}
            >
              {hours.map((h, i) => (
                <div
                  key={h}
                  className="absolute left-0 right-0 border-t border-border/40"
                  style={{ top: i * HOUR_PX }}
                />
              ))}
              {(bookingsByDay[date] ?? []).map((b, index) => {
                const hour = zonedHour(b.scheduledFor, timeZone);
                // Clamp so an early-morning or late-night job still shows up
                // at the edge of the grid instead of scrolling out of sight.
                const clamped = Math.min(
                  Math.max(hour, GRID_START_HOUR),
                  GRID_END_HOUR,
                );
                const top = (clamped - GRID_START_HOUR) * HOUR_PX;
                const color = blockColor(b);
                return (
                  <div
                    key={b.bookingId}
                    className="absolute rounded-md px-1.5 py-1 text-[11px] leading-tight text-white overflow-hidden shadow-sm"
                    style={{
                      top: top + 1,
                      height: HOUR_PX - 4,
                      // Overlapping jobs fan out slightly rather than hiding
                      // each other completely.
                      left: 3 + index * 4,
                      right: 3,
                      background: color,
                      opacity: b.status === "canceled" ? 0.45 : 1,
                      textDecoration:
                        b.status === "canceled" ? "line-through" : undefined,
                    }}
                    title={`${b.customerName} · ${zonedClock(b.scheduledFor, timeZone)}${
                      b.located ? "" : " · no map pin yet"
                    }`}
                  >
                    <div className="font-semibold truncate">
                      {zonedClock(b.scheduledFor, timeZone)}
                    </div>
                    <div className="truncate opacity-90">{b.customerName}</div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function formatHour(hour: number): string {
  const suffix = hour >= 12 ? "pm" : "am";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${suffix}`;
}
