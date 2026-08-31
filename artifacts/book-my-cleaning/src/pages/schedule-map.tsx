/**
 * Schedule & Map — the combined page from the owner's old system: a mini map
 * on top (jobs, cleaner positions and homes for the dates in view, filtered
 * by the same cleaner roster strip as the Live Map) with the full calendar
 * below it, sharing one date range.
 *
 * The point is the workflow: type an address into the search box, see the
 * temporary pin and who is closest, and eyeball travel while filling out the
 * scheduling details underneath — without bouncing between two pages.
 */
import { useMemo, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";
import { PageHeader, LoadingSpinner } from "@/components/ui/shared";
import {
  useGetCompany,
  useGetMapConfig,
  useGetMapData,
  useGetCurrentUser,
  useGetSchedule,
  useGetStaffPresence,
  useListBookingsInRange,
  geocodeMapAddress,
  getGetMapDataQueryKey,
  getGetScheduleQueryKey,
  getGetStaffPresenceQueryKey,
  getListBookingsInRangeQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { AddressLookup } from "@/components/AddressLookup";
import {
  CleanerRoster,
  useHiddenCleaners,
  useHiddenPins,
} from "@/components/CleanerRoster";
import {
  MiniMap,
  type BookingFocus,
  type SearchTarget,
} from "@/components/MiniMap";
import { MonthBoard, WeekBoard } from "@/components/ScheduleCalendar";
import { BookingDetailPanel } from "@/components/BookingDetailPanel";
import { DayView, CrewLegend } from "@/pages/schedule";
import { hasCoords } from "@/lib/mapMarkers";
import { companyTimeZone, zoneLabel } from "@/lib/time";
import { todayInZone, shiftDay } from "@/lib/schedule";
import {
  viewRange,
  groupByDay,
  shiftMonth,
  monthLabel,
  shortDayLabel,
} from "@/lib/mapCalendar";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  MapPin,
} from "lucide-react";

const REFRESH_MS = 30 * 1000;

type ScheduleView = "month" | "week" | "day";

const VIEWS: { id: ScheduleView; label: string }[] = [
  { id: "month", label: "Month" },
  { id: "week", label: "Week" },
  { id: "day", label: "Day" },
];

export function ScheduleMapPage() {
  return (
    <AppLayout>
      <PanelErrorBoundary label="schedule and map">
        <ScheduleMapView />
      </PanelErrorBoundary>
    </AppLayout>
  );
}

function ScheduleMapView() {
  const { data: company } = useGetCompany();
  const timeZone = companyTimeZone(company);
  const today = todayInZone(timeZone);

  const [view, setView] = useState<ScheduleView>("month");
  const [date, setDate] = useState(today);
  const [monthAnchor, setMonthAnchor] = useState(`${today.slice(0, 7)}-01`);
  const [openBookingId, setOpenBookingId] = useState<number | null>(null);
  // The map folds away when the owner wants the whole calendar on screen.
  const [mapOpen, setMapOpen] = useState(true);
  const [bookingFocus, setBookingFocus] = useState<BookingFocus | null>(null);
  const [searchTarget, setSearchTarget] = useState<SearchTarget | null>(null);
  // A chip click filters both halves: pan the map AND emphasize that
  // cleaner's blocks on the calendar. A second click clears it.
  const [highlight, setHighlight] = useState<number | null>(null);
  const {
    hidden,
    toggle,
    show,
    showAll: showAllCleaners,
    hideAll: hideAllCleaners,
  } = useHiddenCleaners();
  // Pins hidden via the Live Map's Saved locations panel stay hidden here
  // too — one preference, both maps. Unhiding lives on the Live Map.
  const { hidden: hiddenPins } = useHiddenPins();
  const { data: me } = useGetCurrentUser();
  const canBook = me?.role === "owner" || me?.role === "dispatcher";

  // One span drives both halves: what the calendar shows is what the map pins.
  const range = useMemo(
    () => viewRange(view, date, monthAnchor),
    [view, date, monthAnchor],
  );
  const rangeParams = useMemo(
    () => ({ start: range.start, end: range.end }),
    [range.start, range.end],
  );
  const mapParams = useMemo(
    () => ({ date: range.start, end: range.end }),
    [range.start, range.end],
  );

  const { data: config, isLoading: configLoading } = useGetMapConfig();

  // Who's out working right now — same signal as the live cars on the mini
  // map above, repeated as green dots on the calendar half.
  const { data: presence } = useGetStaffPresence({
    query: {
      queryKey: getGetStaffPresenceQueryKey(),
      refetchInterval: 60_000,
    },
  });
  const liveIds = useMemo(
    () => new Set(presence?.liveMemberIds ?? []),
    [presence],
  );

  const { data: mapData } = useGetMapData(mapParams, {
    query: {
      queryKey: getGetMapDataQueryKey(mapParams),
      refetchInterval: REFRESH_MS,
      refetchOnWindowFocus: true,
      enabled: Boolean(config?.configured),
    },
  });

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
      setDate(nextAnchor);
      return;
    }
    jumpTo(shiftDay(date, view === "week" ? delta * 7 : delta));
  };

  const openDay = (next: string) => {
    jumpTo(next);
    setView("day");
  };

  // Clicking a visit on the calendar: open its details AND, when the map has
  // a pin for it, sit the mini map on that pin — the whole point of stacking
  // the two on one page.
  const selectBooking = (bookingId: number) => {
    setOpenBookingId(bookingId);
    const located = (mapData?.jobs ?? []).some(
      (j) => j.bookingId === bookingId && hasCoords(j),
    );
    if (located) {
      setMapOpen(true);
      setBookingFocus({ bookingId });
    }
  };

  const spanLabel =
    view === "month"
      ? monthLabel(monthAnchor)
      : view === "week"
        ? `${shortDayLabel(range.dates[0]!)} – ${shortDayLabel(range.dates[range.dates.length - 1]!)}`
        : shortDayLabel(date);

  return (
    <>
      <PageHeader
        title="Schedule & Map"
        description={`Your calendar with the map right above it, in ${zoneLabel(timeZone)} — type an address to see what's nearby while you schedule.`}
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
        </div>
      </PageHeader>

      <div className="space-y-4">
        {/* Positions withheld by the server outside dispatch hours — say why,
            or the empty map reads as "nobody is working today". */}
        {mapData?.livePositions && !mapData.livePositions.allowed && (
          <div
            className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            data-testid="banner-live-withheld"
          >
            {mapData.livePositions.reason}
          </div>
        )}

        {/* ── The mini map, collapsible ─────────────────────────── */}
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2
              className="text-xl font-bold text-foreground"
              data-testid="text-schedule-map-span"
            >
              {spanLabel}
            </h2>
            <button
              type="button"
              onClick={() => setMapOpen((v) => !v)}
              aria-expanded={mapOpen}
              data-testid="button-toggle-mini-map"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              <MapPin className="w-4 h-4" />
              {mapOpen ? "Hide map" : "Show map"}
              {mapOpen ? (
                <ChevronUp className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </button>
          </div>

          {mapOpen &&
            (configLoading ? (
              <LoadingSpinner className="my-8" />
            ) : !config?.configured ? (
              <div className="bg-card border border-border rounded-xl shadow-sm p-6 text-center text-sm text-muted-foreground">
                The map needs a Google Maps API key — the calendar below works
                without it.
              </div>
            ) : (
              <PanelErrorBoundary label="map">
                <div className="space-y-3">
                  <AddressLookup
                    mapData={mapData}
                    target={searchTarget}
                    onTarget={setSearchTarget}
                  />
                  <MiniMap
                    apiKey={config.apiKey}
                    mapData={mapData}
                    timeZone={timeZone}
                    hiddenCleaners={hidden}
                    hiddenPins={hiddenPins}
                    bookingFocus={bookingFocus}
                    searchTarget={searchTarget}
                    canBook={canBook}
                  />
                  <CleanerRoster
                    data={mapData}
                    hidden={hidden}
                    onToggle={toggle}
                    onShowAll={showAllCleaners}
                    onHideAll={hideAllCleaners}
                    highlighted={highlight}
                    onClearHighlight={() => setHighlight(null)}
                    onFocus={(c) => {
                      show(c.teamMemberId);
                      setHighlight((prev) =>
                        prev === c.teamMemberId ? null : c.teamMemberId,
                      );
                      if (c.focus) {
                        setSearchTarget({
                          label: c.name,
                          lat: c.focus.lat,
                          lng: c.focus.lng,
                        });
                      }
                    }}
                  />
                </div>
              </PanelErrorBoundary>
            ))}
        </div>

        {/* ── The calendar ──────────────────────────────────────── */}
        <PanelErrorBoundary label="calendar">
          {view === "day" ? (
            <DayView
              schedule={schedule}
              isLoading={dayLoading}
              date={date}
              timeZone={timeZone}
              onSelectBooking={selectBooking}
              highlight={highlight}
              liveIds={liveIds}
            />
          ) : rangeLoading ? (
            <LoadingSpinner className="mt-16" />
          ) : (
            <div className="space-y-3">
              {view === "month" ? (
                <MonthBoard
                  monthAnchor={monthAnchor}
                  dates={range.dates}
                  today={today}
                  bookingsByDay={bookingsByDay}
                  timeZone={timeZone}
                  onOpenDay={openDay}
                  onSelectBooking={selectBooking}
                  highlight={highlight}
                />
              ) : (
                <WeekBoard
                  dates={range.dates}
                  today={today}
                  bookingsByDay={bookingsByDay}
                  timeZone={timeZone}
                  onOpenDay={openDay}
                  onSelectBooking={selectBooking}
                  highlight={highlight}
                />
              )}
              <CrewLegend
                bookings={rangeData?.bookings ?? []}
                liveIds={liveIds}
              />
            </div>
          )}
        </PanelErrorBoundary>
      </div>

      <BookingDetailPanel
        bookingId={openBookingId}
        onClose={() => setOpenBookingId(null)}
      />
    </>
  );
}

export default ScheduleMapPage;
