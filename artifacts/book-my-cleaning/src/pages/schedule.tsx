/**
 * The Schedule page — the whole calendar, not just today.
 *
 * Month shows every visit in the grid, week lays them out by the hour, and day
 * splits the work into one lane per cleaner. Month and week come from the
 * lightweight range endpoint (no prices, no phone numbers, so a cleaner can
 * open the same board); day comes from the schedule endpoint, which carries
 * the detail a dispatcher needs when they're actually running the day.
 *
 * Every time on this page is drawn in the company's timezone — the hour the
 * customer was quoted — never the browser's.
 */
import { useMemo, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";
import { PageHeader, LoadingSpinner } from "@/components/ui/shared";
import {
  useGetSchedule,
  useGetCompany,
  useGetCurrentUser,
  useListBookingsInRange,
  getGetScheduleQueryKey,
  getListBookingsInRangeQueryKey,
  BookingRangeItem,
  ScheduleJob,
  ScheduleCleaner,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { JobberSyncButton } from "@/components/JobberSyncButton";
import { MonthBoard, WeekBoard } from "@/components/ScheduleCalendar";
import { colorForTeamMember } from "@/lib/mapMarkers";
import { companyTimeZone, formatZoned, zoneLabel } from "@/lib/time";
import {
  todayInZone,
  shiftDay,
  sortJobsByTime,
  totalDurationMinutes,
  formatDuration,
  formatPrice,
} from "@/lib/schedule";
import {
  viewRange,
  groupByDay,
  shiftMonth,
  monthLabel,
  shortDayLabel,
  zonedClock,
  zonedDayKey,
} from "@/lib/mapCalendar";
import {
  ChevronLeft,
  ChevronRight,
  Calendar,
  MapPin,
  Clock,
  User,
  Users,
} from "lucide-react";

type ScheduleView = "month" | "week" | "day";

const VIEWS: { id: ScheduleView; label: string }[] = [
  { id: "month", label: "Month" },
  { id: "week", label: "Week" },
  { id: "day", label: "Day" },
];

export function SchedulePage() {
  const { data: company } = useGetCompany();
  const { data: me } = useGetCurrentUser();
  const queryClient = useQueryClient();
  const timeZone = companyTimeZone(company);
  const today = todayInZone(timeZone);

  const [view, setView] = useState<ScheduleView>("month");
  const [date, setDate] = useState(today);
  const [monthAnchor, setMonthAnchor] = useState(`${today.slice(0, 7)}-01`);

  const range = useMemo(
    () => viewRange(view, date, monthAnchor),
    [view, date, monthAnchor],
  );
  const rangeParams = useMemo(
    () => ({ start: range.start, end: range.end }),
    [range.start, range.end],
  );

  // Month and week read the range endpoint; the day view has its own, richer
  // one, so we don't pay for both at once.
  const { data: rangeData, isLoading: rangeLoading } = useListBookingsInRange(
    rangeParams,
    {
      query: {
        queryKey: getListBookingsInRangeQueryKey(rangeParams),
        enabled: view !== "day",
      },
    },
  );

  const { data: schedule, isLoading: dayLoading } = useGetSchedule(
    { date },
    {
      query: {
        queryKey: getGetScheduleQueryKey({ date }),
        enabled: view === "day",
      },
    },
  );

  const bookingsByDay = useMemo(
    () => groupByDay(rangeData?.bookings ?? [], timeZone),
    [rangeData, timeZone],
  );

  const jumpTo = (next: string) => {
    setDate(next);
    setMonthAnchor(`${next.slice(0, 7)}-01`);
  };

  const step = (delta: number) => {
    if (view === "month") {
      const nextAnchor = shiftMonth(monthAnchor, delta);
      setMonthAnchor(nextAnchor);
      // Keep the selection inside the month on screen, so switching to day or
      // week after paging lands where the owner is looking.
      setDate(nextAnchor);
      return;
    }
    jumpTo(shiftDay(date, view === "week" ? delta * 7 : delta));
  };

  const openDay = (next: string) => {
    jumpTo(next);
    setView("day");
  };

  const spanLabel =
    view === "month"
      ? monthLabel(monthAnchor)
      : view === "week"
        ? `${shortDayLabel(range.dates[0]!)} – ${shortDayLabel(range.dates[range.dates.length - 1]!)}`
        : formatDateHeading(date);

  // Pulling from Jobber writes bookings, so it stays with the people allowed
  // to change the schedule.
  const canManageJobber = me?.role === "owner" || me?.role === "dispatcher";

  return (
    <AppLayout>
      <PageHeader
        title="Schedule"
        description={`Every visit on your calendar, in ${zoneLabel(timeZone)} — the time your customers were quoted.`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-lg border border-border overflow-hidden">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => setView(v.id)}
                aria-pressed={view === v.id}
                data-testid={`button-view-${v.id}`}
                className={[
                  "px-3 h-9 text-sm font-medium transition-colors",
                  view === v.id
                    ? "brand-gradient text-white"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                ].join(" ")}
              >
                {v.label}
              </button>
            ))}
          </div>

          <Button
            variant="outline"
            size="icon"
            onClick={() => step(-1)}
            aria-label={`Previous ${view}`}
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => step(1)}
            aria-label={`Next ${view}`}
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
          <Button
            variant={date === today ? "default" : "outline"}
            onClick={() => jumpTo(today)}
            className={date === today ? "brand-gradient text-white" : ""}
          >
            Today
          </Button>
          <input
            type="date"
            value={date}
            onChange={(e) => {
              if (e.target.value) jumpTo(e.target.value);
            }}
            className="h-9 rounded-md border border-border bg-input px-3 text-sm text-foreground"
            aria-label="Jump to date"
          />
          {canManageJobber && (
            <JobberSyncButton
              connected={Boolean(company?.jobberConnected)}
              needsReauth={Boolean(company?.jobberNeedsReauth)}
              connectHint="Connect Jobber to pull your scheduled jobs onto this calendar."
              onSynced={() => {
                queryClient.invalidateQueries({
                  queryKey: getListBookingsInRangeQueryKey(rangeParams),
                });
                queryClient.invalidateQueries({
                  queryKey: getGetScheduleQueryKey({ date }),
                });
              }}
            />
          )}
        </div>
      </PageHeader>

      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2
          className="text-xl font-bold text-foreground"
          data-testid="text-schedule-span"
        >
          {spanLabel}
        </h2>
        {view !== "day" && rangeData && (
          <span className="text-sm text-muted-foreground">
            {rangeData.bookings.length}{" "}
            {rangeData.bookings.length === 1 ? "visit" : "visits"} in view
          </span>
        )}
      </div>

      <PanelErrorBoundary label="schedule">
        {view === "day" ? (
          <DayView
            schedule={schedule}
            isLoading={dayLoading}
            date={date}
            timeZone={timeZone}
          />
        ) : rangeLoading ? (
          <LoadingSpinner className="mt-20" />
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_18rem] gap-4 items-start">
            <div className="space-y-3 min-w-0">
              {view === "month" ? (
                <MonthBoard
                  monthAnchor={monthAnchor}
                  dates={range.dates}
                  today={today}
                  bookingsByDay={bookingsByDay}
                  timeZone={timeZone}
                  onOpenDay={openDay}
                />
              ) : (
                <WeekBoard
                  dates={range.dates}
                  today={today}
                  bookingsByDay={bookingsByDay}
                  timeZone={timeZone}
                  onOpenDay={openDay}
                />
              )}
              <CrewLegend bookings={rangeData?.bookings ?? []} />
            </div>
            <NeedsCrewRail
              bookings={rangeData?.bookings ?? []}
              timeZone={timeZone}
            />
          </div>
        )}
      </PanelErrorBoundary>
    </AppLayout>
  );
}

/* ───────────────────────── Day view ───────────────────────── */

function DayView({
  schedule,
  isLoading,
  date,
  timeZone,
}: {
  schedule:
    { cleaners: ScheduleCleaner[]; unassigned: ScheduleJob[] } | undefined;
  isLoading: boolean;
  date: string;
  timeZone: string;
}) {
  if (isLoading) return <LoadingSpinner className="mt-20" />;

  const hasCleaners = (schedule?.cleaners.length ?? 0) > 0;
  const hasUnassigned = (schedule?.unassigned.length ?? 0) > 0;

  if (!hasCleaners && !hasUnassigned) {
    return (
      <div className="bg-card border border-border rounded-xl shadow-sm p-12 text-center">
        <div className="w-12 h-12 bg-secondary rounded-full flex items-center justify-center mx-auto mb-4">
          <Calendar className="w-6 h-6 text-muted-foreground" />
        </div>
        <h3 className="font-semibold text-foreground mb-1">
          Nobody scheduled for this day
        </h3>
        <p className="text-sm text-muted-foreground max-w-sm mx-auto">
          There are no jobs on {formatDateHeading(date)}. Assign crews from the
          Bookings page and they&apos;ll show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 items-start">
      {schedule!.cleaners.map((cleaner) => (
        <CleanerLane
          key={cleaner.teamMemberId}
          cleaner={cleaner}
          timeZone={timeZone}
        />
      ))}
      {hasUnassigned && (
        <UnassignedLane jobs={schedule!.unassigned} timeZone={timeZone} />
      )}
    </div>
  );
}

/* ─────────────────── Range-view side panels ─────────────────── */

/**
 * Work in view that nobody is on yet. Jobber calls its equivalent
 * "Unscheduled"; here the visit already has a time, what it's missing is a
 * person — so the rail says exactly that, and only appears when there is
 * something to fix.
 */
function NeedsCrewRail({
  bookings,
  timeZone,
}: {
  bookings: BookingRangeItem[];
  timeZone: string;
}) {
  const open = bookings.filter(
    (b) => b.assignees.length === 0 && b.status !== "canceled",
  );

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-secondary/40 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-brand-pink" />
          <span className="font-semibold text-foreground">Needs a crew</span>
        </div>
        <span className="text-xs text-muted-foreground">{open.length}</span>
      </div>
      {open.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          Every visit in view has someone on it.
        </p>
      ) : (
        <div className="max-h-[36rem] overflow-y-auto divide-y divide-border/60">
          {open.map((booking) => (
            <Link
              key={booking.bookingId}
              href={`/bookings#booking-${booking.bookingId}`}
              className="block px-4 py-3 hover:bg-secondary/50 transition-colors"
            >
              <div className="text-sm font-medium text-foreground truncate">
                {booking.customerName}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {booking.service}
              </div>
              <div className="text-xs text-brand-pink mt-0.5">
                {shortDayLabel(zonedDayKey(booking.scheduledFor, timeZone))} ·{" "}
                {zonedClock(booking.scheduledFor, timeZone)}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** Which colour belongs to whom, so the blocks above can be read at a glance. */
function CrewLegend({ bookings }: { bookings: BookingRangeItem[] }) {
  const crew = new Map<number, string>();
  let anyUnassigned = false;
  for (const booking of bookings) {
    const first = booking.assignees[0];
    if (first) crew.set(first.teamMemberId, first.name);
    else anyUnassigned = true;
  }
  if (crew.size === 0 && !anyUnassigned) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-xs text-muted-foreground">
      {[...crew.entries()].map(([id, name]) => (
        <span key={id} className="flex items-center gap-1.5">
          <span
            className="w-2.5 h-2.5 rounded-sm"
            style={{ background: colorForTeamMember(id) }}
          />
          {name}
        </span>
      ))}
      {anyUnassigned && (
        <span className="flex items-center gap-1.5">
          <span
            className="w-2.5 h-2.5 rounded-sm"
            style={{ background: "hsl(330, 81%, 60%)" }}
          />
          Needs a crew
        </span>
      )}
    </div>
  );
}

/* ───────────────────────── Day lanes ───────────────────────── */

function CleanerLane({
  cleaner,
  timeZone,
}: {
  cleaner: ScheduleCleaner;
  timeZone: string;
}) {
  const jobs = sortJobsByTime(cleaner.jobs);
  const total = totalDurationMinutes(cleaner.jobs);

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-secondary/40 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-sm shrink-0">
            {cleaner.name.charAt(0).toUpperCase()}
          </div>
          <span className="font-semibold text-foreground truncate">
            {cleaner.name}
          </span>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">
          {jobs.length} {jobs.length === 1 ? "job" : "jobs"}
          {total > 0 ? ` · ${formatDuration(total)}` : ""}
        </span>
      </div>
      <div className="p-3 space-y-3">
        {jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No jobs booked.
          </p>
        ) : (
          jobs.map((job) => (
            <JobCard key={job.bookingId} job={job} timeZone={timeZone} />
          ))
        )}
      </div>
    </div>
  );
}

function UnassignedLane({
  jobs,
  timeZone,
}: {
  jobs: ScheduleJob[];
  timeZone: string;
}) {
  const sorted = sortJobsByTime(jobs);
  return (
    <div className="bg-card border border-amber-500/30 rounded-xl shadow-sm flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-amber-500/30 bg-amber-500/10 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-amber-400" />
          <span className="font-semibold text-amber-300">Unassigned</span>
        </div>
        <span className="text-xs text-amber-300/80">
          {sorted.length} {sorted.length === 1 ? "job" : "jobs"}
        </span>
      </div>
      <div className="p-3 space-y-3">
        <p className="text-xs text-amber-300/80 -mt-1">
          Nobody is on these yet — assign a crew from Bookings.
        </p>
        {sorted.map((job) => (
          <JobCard key={job.bookingId} job={job} timeZone={timeZone} />
        ))}
      </div>
    </div>
  );
}

function JobCard({ job, timeZone }: { job: ScheduleJob; timeZone: string }) {
  const price = formatPrice(job.price);
  const duration = formatDuration(job.durationMinutes);
  return (
    <Link href={`/bookings#booking-${job.bookingId}`}>
      <div className="rounded-lg border border-border bg-background/40 p-3 hover:border-brand-pink/40 hover:bg-secondary/40 transition-colors cursor-pointer">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Clock className="w-3.5 h-3.5 text-brand-pink shrink-0" />
            {formatZoned(job.scheduledFor, timeZone).replace(/^.*at\s/, "")}
          </div>
          <JobStatusBadge status={job.status} />
        </div>
        <div className="mt-2 space-y-1 text-sm">
          <div className="flex items-center gap-1.5 text-foreground">
            <User className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="font-medium truncate">{job.customerName}</span>
          </div>
          <div className="flex items-start gap-1.5 text-muted-foreground text-xs">
            <MapPin className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{job.customerAddress || "Address not provided"}</span>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>{duration || "—"}</span>
          {price && (
            <span className="font-semibold text-foreground tabular-nums">
              {price}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

function JobStatusBadge({ status }: { status: ScheduleJob["status"] }) {
  const styles: Record<ScheduleJob["status"], string> = {
    pending: "bg-secondary text-muted-foreground border-border",
    confirmed: "bg-brand-blue/10 text-brand-blue border-brand-blue/20",
    completed: "bg-green-500/10 text-green-400 border-green-500/20",
    canceled: "bg-red-500/10 text-red-400 border-red-500/20",
  };
  return (
    <Badge
      variant="outline"
      className={`text-[10px] py-0 h-5 capitalize ${styles[status]}`}
    >
      {status}
    </Badge>
  );
}

function formatDateHeading(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const [, y, m, d] = match.map(Number) as unknown as number[];
  return new Date(Date.UTC(y!, m! - 1, d!, 12)).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
