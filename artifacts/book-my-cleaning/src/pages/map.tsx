import { useEffect, useMemo, useRef, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { SavedRoutesPanel } from "@/components/SavedRoutesPanel";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";
import { PageHeader, LoadingSpinner } from "@/components/ui/shared";
import {
  useGetMapConfig,
  useGetMapData,
  useGetMapDrivingRoute,
  useGetMapRoutes,
  useListBookingsInRange,
  useCreateMapPin,
  useDeleteMapPin,
  useUpdateMapPin,
  useListSavedRoutes,
  useGetSavedRoute,
  useCreateSavedRoute,
  useUpdateSavedRoute,
  useDeleteSavedRoute,
  useAddSavedRouteStop,
  useReorderSavedRouteStops,
  useUpdateSavedRouteStop,
  useDeleteSavedRouteStop,
  useSyncJobberCalendar,
  useGetCompany,
  useGetCurrentUser,
  geocodeMapAddress,
  getGetMapDataQueryKey,
  getGetMapDrivingRouteQueryKey,
  getGetMapRoutesQueryKey,
  getListBookingsInRangeQueryKey,
  getListSavedRoutesQueryKey,
  getGetSavedRouteQueryKey,
  MapData,
  GetMapDataParams,
  type MapRouteLeg,
  type SavedRoute,
  type SavedRouteStop,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import {
  CleanerRoster,
  useHiddenCleaners,
  useHiddenPins,
  useShowTrails,
} from "@/components/CleanerRoster";
import { Switch } from "@/components/ui/switch";
import type { RosterCleaner } from "@/lib/cleanerRoster";
import { MonthCalendar, ColumnCalendar } from "@/components/MapCalendar";
import { JobberSyncButton } from "@/components/JobberSyncButton";
import { DeviceManager } from "@/components/DeviceManager";
import { useToast } from "@/hooks/use-toast";
import { companyTimeZone, formatZoned, zoneLabel } from "@/lib/time";
import { todayInZone, shiftDay } from "@/lib/schedule";
import { parseMapFocus } from "@/lib/mapFocus";
import {
  type CalendarView,
  viewRange,
  groupByDay,
  shiftMonth,
  shortDayLabel,
} from "@/lib/mapCalendar";
import {
  loadGoogleMaps,
  reverseGeocode,
  DEMO_MAP_ID,
  type GoogleMapsApi,
} from "@/lib/googleMaps";
import {
  colorForTeamMember,
  markerStyleFor,
  deviceLabelFor,
  initials,
  isStale,
  lastSeenLabel,
  hasCoords,
  partitionJobsByCoords,
  assigneeNames,
  crewChipsFor,
  accuracyLabel,
} from "@/lib/mapMarkers";
import {
  nearestCleaners,
  formatKm,
  formatDriveMinutes,
  type Coords,
  type NearbyCleaner,
} from "@/lib/nearest";
import { closestCrewHtml } from "@/lib/closestCrewCard";
import {
  routePlanLegs,
  routePlanTotalKm,
  moveRouteStop,
  type RoutePlanStop,
} from "@/lib/mapRoutePlan";
import {
  visibleTrails,
  midpointOf,
  chipLabel,
  headingLabel,
} from "@/lib/routeTrails";
import { useLateAlerts } from "@/lib/useLateAlerts";
import { pointsToFrame } from "@/lib/mapFraming";
import { selectMapMarkers } from "@/lib/mapMarkerSelection";
import { toggleMapMarkerCard } from "@/lib/mapInfoWindow";
import { droppedPinColor, droppedPinOrdinal } from "@/lib/mapDroppedPins";
import {
  carSvg,
  crewBadgeRow,
  crosshairSvg,
  directionsHtml,
  editInBookingsHtml,
  escapeHtml,
  focusAddressTag,
  homeSvg,
  officeMarker,
  OFFICE_COLOR,
  measureChip,
  measureEndpoint,
  MEASURE_COLOR,
  pinMarker,
  shortName,
  waypointMarker,
} from "@/lib/mapMarkerDom";
import {
  IDLE_TOOLS,
  addMeasurePoint,
  addRouteDraftPoint,
  clearRouteAddDraft,
  cancelTool,
  clearMeasurement,
  formatDrivingMeasurement,
  measurementOf,
  measurePointLabel,
  setMeasurementPoints,
  startMovingPin,
  toggleDropMode,
  toggleMeasureMode,
  toggleRouteAddMode,
  type MapToolState,
  type MeasurePoint,
} from "@/lib/mapMeasure";
import {
  MapPin,
  RefreshCw,
  AlertTriangle,
  Home,
  Users,
  Briefcase,
  Trash2,
  Plus,
  Search,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  CalendarRange,
  LayoutGrid,
  CalendarClock,
  Crosshair,
  Building2,
  X,
  Navigation,
  Car,
  Ruler,
} from "lucide-react";

const REFRESH_MS = 30 * 1000;

/**
 * Where the map sits before anything has been plotted on it — the city these
 * companies work in. It is only ever the starting view: as soon as there is a
 * job, a cleaner or a saved pin, the map fits itself around them instead.
 */
const HOME_CENTER = { lat: 53.5461, lng: -113.4938 }; // Edmonton
const HOME_ZOOM = 11;

/**
 * A single pin has no width, so fitting to it would drop the map to rooftop
 * zoom and lose all sense of where in the city it is. Cap it at a level that
 * still shows the surrounding neighbourhoods.
 */
const MAX_FIT_ZOOM = 14;

/**
 * The other end of the same problem: never pull back so far that the city is a
 * smudge. This is a service-area map, not an atlas — if something genuinely
 * sits outside the frame at this level, it is off screen and the dispatcher can
 * zoom out to it, which is far better than every normal day being drawn from
 * orbit because of one bad address.
 */
const MIN_FIT_ZOOM = 10;
// Close enough to see the street when one job was asked for by name.
const FOCUS_ZOOM = 16;

export function MapPage() {
  return (
    <AppLayout>
      <PanelErrorBoundary label="live map">
        <MapView />
      </PanelErrorBoundary>
    </AppLayout>
  );
}

const VIEW_TABS: { id: CalendarView; label: string; icon: typeof MapPin }[] = [
  { id: "day", label: "Day", icon: CalendarClock },
  { id: "3day", label: "3-Day", icon: CalendarDays },
  { id: "week", label: "Week", icon: CalendarRange },
  { id: "month", label: "Month", icon: LayoutGrid },
];

function MapView() {
  const { data: company } = useGetCompany();
  const queryClient = useQueryClient();
  const timeZone = companyTimeZone(company);
  const today = todayInZone(timeZone);

  // Another page can hand us a job to look at ("Show on map" in a booking).
  // Read once, on mount: after that the dispatcher is driving.
  const [focus] = useState(() =>
    parseMapFocus(typeof window === "undefined" ? "" : window.location.search),
  );

  const [view, setView] = useState<CalendarView>("day");
  // "Where are my clients" rather than "where is the crew today". The calendar
  // below keeps following the selected dates either way — only the map lets go
  // of them, so switching back doesn't lose the dispatcher's place.
  const [showAllPins, setShowAllPins] = useState(false);
  const [selectedDate, setSelectedDate] = useState(focus.date ?? today);
  const [monthAnchor, setMonthAnchor] = useState(
    () => `${(focus.date ?? today).slice(0, 7)}-01`,
  );
  // Centring on one job only makes sense until the dispatcher moves the day
  // or the view themselves — then it would be yanking the map back.
  const [focusJobId, setFocusJobId] = useState<number | null>(focus.jobId);

  // What the calendar shows is exactly what the map pins — one span, two views
  // of it, so a dispatcher never wonders which jobs are missing.
  const range = useMemo(
    () => viewRange(view, selectedDate, monthAnchor),
    [view, selectedDate, monthAnchor],
  );

  const {
    data: config,
    isLoading: configLoading,
    error: configError,
  } = useGetMapConfig();

  const mapParams = useMemo(
    () => (showAllPins ? { all: true } : { date: range.start, end: range.end }),
    [showAllPins, range.start, range.end],
  );

  const {
    data: mapData,
    isFetching,
    dataUpdatedAt,
    refetch,
  } = useGetMapData(mapParams, {
    query: {
      queryKey: getGetMapDataQueryKey(mapParams),
      // Live view: poll while the tab is open so a dead phone or a new job
      // shows up without a manual refresh.
      refetchInterval: REFRESH_MS,
      refetchOnWindowFocus: true,
    },
  });

  // Separate from the map data on purpose: the calendar must also show jobs
  // that have no coordinates yet, otherwise an un-geocoded booking looks like
  // a free afternoon.
  const rangeParams = useMemo(
    () => ({ start: range.start, end: range.end }),
    [range.start, range.end],
  );

  const { data: rangeData } = useListBookingsInRange(rangeParams, {
    query: {
      queryKey: getListBookingsInRangeQueryKey(rangeParams),
      refetchInterval: REFRESH_MS,
      refetchOnWindowFocus: true,
    },
  });

  const bookingsByDay = useMemo(
    () => groupByDay(rangeData?.bookings ?? [], timeZone),
    [rangeData, timeZone],
  );

  const jumpToDate = (date: string) => {
    setFocusJobId(null);
    setSelectedDate(date);
    setMonthAnchor(`${date.slice(0, 7)}-01`);
  };

  const stepDate = (delta: number) => {
    const step = view === "week" ? 7 : view === "3day" ? 3 : 1;
    jumpToDate(shiftDay(selectedDate, delta * step));
  };

  // The dispatcher taking over — any deliberate move off the focused job
  // hands the viewport back to the normal "frame the whole day" behaviour.
  const pickDate = (date: string) => {
    setFocusJobId(null);
    setSelectedDate(date);
  };

  const pickView = (next: CalendarView) => {
    setFocusJobId(null);
    setView(next);
  };

  const isRangeView = view !== "day";

  // Pulling from Jobber writes bookings, so it stays with the people who are
  // allowed to change the schedule. It is deliberately NOT hidden when Jobber
  // is disconnected — a control that only appears once you've already done the
  // setup is a control nobody knows exists, so it stays put and says what it
  // needs instead.
  const { data: me } = useGetCurrentUser();
  const canManageJobber = me?.role === "owner" || me?.role === "dispatcher";

  return (
    <>
      <PageHeader
        title="Live Map"
        description="Where your crews are right now, the jobs on your calendar, your cleaners' home addresses and every place you've worked."
      >
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => {
              if (e.target.value) jumpToDate(e.target.value);
            }}
            className="h-9 rounded-md border border-border bg-input px-3 text-sm text-foreground"
            aria-label="Jump to date"
          />
          <Button variant="outline" size="sm" onClick={() => jumpToDate(today)}>
            Today
          </Button>
          <Button
            variant={showAllPins ? "default" : "outline"}
            size="sm"
            aria-pressed={showAllPins}
            onClick={() => setShowAllPins((v) => !v)}
            data-testid="button-toggle-all-pins"
            className={showAllPins ? "brand-gradient text-white" : ""}
            title="Every client address you've worked at, ignoring the dates"
          >
            <MapPin className="w-4 h-4 mr-1.5" />
            All homes
          </Button>
          {canManageJobber && (
            <JobberSyncButton
              connected={Boolean(company?.jobberConnected)}
              needsReauth={Boolean(company?.jobberNeedsReauth)}
              connectHint="Connect Jobber to pull your scheduled jobs onto this map."
              onSynced={() => {
                // The calendar's span is not the map's when "All clients" is
                // on, so both caches are cleared by their own key rather than
                // deriving one from the other.
                queryClient.invalidateQueries({
                  queryKey: getGetMapDataQueryKey(mapParams),
                });
                queryClient.invalidateQueries({
                  queryKey: getListBookingsInRangeQueryKey(rangeParams),
                });
              }}
            />
          )}
          <Button
            variant="outline"
            size="icon"
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label="Refresh map"
          >
            <RefreshCw
              className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`}
            />
          </Button>
        </div>
      </PageHeader>

      {/* The server withholds live positions outside dispatch hours. Say so,
          rather than letting an empty map read as "nobody is working". */}
      {mapData?.livePositions && !mapData.livePositions.allowed && (
        <div
          className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          data-testid="banner-live-withheld"
        >
          {mapData.livePositions.reason}
        </div>
      )}

      {configLoading ? (
        <LoadingSpinner className="mt-20" />
      ) : configError || !config ? (
        <UnavailableCard reason="load-config" />
      ) : !config.configured ? (
        <UnavailableCard reason="not-configured" />
      ) : (
        <LiveMap
          apiKey={config.apiKey}
          mapParams={mapParams}
          mapData={mapData}
          timeZone={timeZone}
          lastUpdated={dataUpdatedAt}
          isFetching={isFetching}
          isRangeView={isRangeView}
          showAllPins={showAllPins}
          focusJobId={focusJobId}
          onFocusResolved={setFocusJobId}
          rangeLabel={`${shortDayLabel(range.start)} – ${shortDayLabel(range.end)}`}
          calendar={
            <>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div
                  className="inline-flex rounded-lg border border-border bg-card p-0.5"
                  role="tablist"
                  aria-label="Calendar view"
                >
                  {VIEW_TABS.map((tab) => {
                    const Icon = tab.icon;
                    const active = view === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => pickView(tab.id)}
                        className={[
                          "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                          active
                            ? "brand-gradient text-white shadow-sm"
                            : "text-muted-foreground hover:text-foreground hover:bg-secondary",
                        ].join(" ")}
                      >
                        <Icon className="w-3.5 h-3.5" />
                        {tab.label}
                      </button>
                    );
                  })}
                </div>

                {view !== "month" && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => stepDate(-1)}
                      className="p-1.5 rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                      aria-label="Previous"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <span className="text-sm font-medium text-foreground min-w-[9rem] text-center">
                      {view === "day"
                        ? shortDayLabel(selectedDate)
                        : `${shortDayLabel(range.start)} – ${shortDayLabel(range.end)}`}
                    </span>
                    <button
                      type="button"
                      onClick={() => stepDate(1)}
                      className="p-1.5 rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                      aria-label="Next"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>

              {view === "month" && (
                <MonthCalendar
                  anchor={monthAnchor}
                  dates={range.dates}
                  selectedDate={selectedDate}
                  today={today}
                  bookingsByDay={bookingsByDay}
                  onSelectDate={pickDate}
                  onShiftMonth={(delta) =>
                    setMonthAnchor((m) => shiftMonth(m, delta))
                  }
                />
              )}

              {(view === "3day" || view === "week") && (
                <ColumnCalendar
                  dates={range.dates}
                  selectedDate={selectedDate}
                  today={today}
                  bookingsByDay={bookingsByDay}
                  timeZone={timeZone}
                  onSelectDate={pickDate}
                />
              )}
            </>
          }
        />
      )}
    </>
  );
}

/**
 * Calm explanatory card for the two states where the map genuinely can't run:
 * the key isn't set up, or /map/config itself failed. Never a crash or an
 * endless spinner — the owner needs to know what to fix.
 */
function UnavailableCard({
  reason,
}: {
  reason: "not-configured" | "load-config";
}) {
  return (
    <div className="bg-card border border-border rounded-xl shadow-sm p-12 text-center">
      <div className="w-12 h-12 bg-secondary rounded-full flex items-center justify-center mx-auto mb-4">
        <MapPin className="w-6 h-6 text-muted-foreground" />
      </div>
      <h3 className="font-semibold text-foreground mb-1">
        The live map isn&apos;t set up yet
      </h3>
      <p className="text-sm text-muted-foreground max-w-md mx-auto">
        {reason === "load-config"
          ? "We couldn't reach the map service. Refresh in a moment, or check back shortly."
          : "A Google Maps API key needs to be configured for your workspace. Add a key with the Maps JavaScript API and Geocoding API enabled to see crews and jobs on a map."}
      </p>
    </div>
  );
}

function LiveMap({
  apiKey,
  mapParams,
  mapData,
  timeZone,
  lastUpdated,
  isFetching,
  isRangeView,
  showAllPins,
  focusJobId,
  onFocusResolved,
  rangeLabel,
  calendar,
}: {
  apiKey: string;
  mapParams: GetMapDataParams;
  mapData: MapData | undefined;
  timeZone: string;
  lastUpdated: number;
  isFetching: boolean;
  isRangeView: boolean;
  showAllPins: boolean;
  focusJobId: number | null;
  onFocusResolved: (jobId: number | null) => void;
  rangeLabel: string;
  calendar: React.ReactNode;
}) {
  const { data: me } = useGetCurrentUser();
  const queryClient = useQueryClient();
  // Crew may watch the map, but adding and removing saved pins is dispatch
  // work and the API rejects it — so don't offer them a control that fails.
  // Positive check on purpose: while the role is still loading we show nothing
  // rather than flashing controls a cleaner could click into a 403.
  const canEditPins = me?.role === "owner" || me?.role === "dispatcher";
  // Whether to draw the trails is the boss's own view choice, so only he is
  // offered the switch.
  const isOwner = me?.role === "owner";
  const { showTrails, setShowTrails } = useShowTrails();
  // The lateness nudge is dispatch's job — a cleaner watching their own
  // trail shouldn't be toasted about themselves. Same positive check as
  // above: while the role loads, nobody is alerted.
  const isDispatch = canEditPins;
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const infoWindowRef = useRef<any>(null);
  const openMarkerRef = useRef<string | null>(null);
  const markersRef = useRef<any[]>([]);
  const searchMarkersRef = useRef<any[]>([]);
  const routeMarkersRef = useRef<any[]>([]);
  const routeLinesRef = useRef<any[]>([]);

  const routeActionsRef = useRef<{
    activeRouteId: number | null;
    addStop: (
      name: string,
      address: string | null,
      lat: number,
      lng: number,
    ) => void;
  }>({
    activeRouteId: null,
    addStop: () => {},
  });

  useEffect(() => {
    routeActionsRef.current.activeRouteId = activeRouteId;
    routeActionsRef.current.addStop = (name, address, lat, lng) => {
      if (!activeRouteId) return;
      addRouteStop.mutate(
        {
          id: activeRouteId,
          data: { name, address, lat, lng },
        },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({
              queryKey: getGetSavedRouteQueryKey(activeRouteId),
            });
            toast({ title: "Stop added to route" });
          },
          onError: (e: any) => {
            toast({
              title: "Couldn't add stop",
              description: e.message,
              variant: "destructive",
            });
          },
        },
      );
    };
  }); // run on every render to capture fresh mutation dependencies

  // Which cleaners the dispatcher has unchecked on the roster strip. Saved
  // locally per user, so the choice follows them around the app.
  const {
    hidden: hiddenCleaners,
    toggle: toggleCleaner,
    show: showCleaner,
    showAll: showAllCleaners,
    hideAll: hideAllCleaners,
  } = useHiddenCleaners();
  // Saved pins the dispatcher has unchecked in the Saved locations panel (or
  // hidden straight from a pin's card). Same per-user persistence as the
  // cleaner hide list, separate storage slot.
  const { hidden: hiddenPins, toggle: togglePin } = useHiddenPins();
  // The trail from each live cleaner to their next job. Polled on the same
  // beat as positions, so the line ages exactly as fast as the car it starts
  // from; the server caches the billed route lookups behind it.
  const { data: routesData } = useGetMapRoutes({
    query: {
      queryKey: getGetMapRoutesQueryKey(),
      refetchInterval: REFRESH_MS,
      refetchOnWindowFocus: true,
    },
  });
  const routesByMember = useMemo(() => {
    const byMember = new Map<number, MapRouteLeg>();
    for (const r of routesData?.routes ?? []) byMember.set(r.teamMemberId, r);
    return byMember;
  }, [routesData]);
  // Ref'd for the imperative marker code, same reason as pinActionsRef: the
  // redraw effect must not depend on a callback identity that changes every
  // render.
  const togglePinRef = useRef(togglePin);
  togglePinRef.current = togglePin;
  // The marker (live car first, home otherwise) for each cleaner currently on
  // the map, so a roster click can jump straight to it and open its card.
  // Keyed by person, not device: the roster strip clicks a name, so several
  // devices have to resolve to one jump target (`updatedAt` picks the
  // freshest).
  const cleanerMarkersRef = useRef(
    new Map<number, { marker: any; content: string; updatedAt?: string }>(),
  );
  // A roster click. Object identity (not just the id) so clicking the same
  // name twice pans back even after the dispatcher dragged away.
  const [cleanerFocus, setCleanerFocus] = useState<{
    teamMemberId: number;
    /** Fallback pan target when no marker is registered for them. */
    lat: number;
    lng: number;
  } | null>(null);
  const [maps, setMaps] = useState<GoogleMapsApi | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [authFailed, setAuthFailed] = useState(false);
  /**
   * Which map tool is armed — drop a pin, move a pin, or measure — plus the
   * measurement itself. One field, never three booleans: all three consume
   * the next map click, and the day two of them are on at once a measuring
   * click saves a pin. Transitions live in mapMeasure.ts and are unit-tested
   * there. Off by default: an always-live click handler would turn every
   * stray click while panning into a saved pin.
   */
  const [tools, setTools] = useState<MapToolState>(IDLE_TOOLS);
  const dropMode = tools.tool === "drop";
  const measureMode = tools.tool === "measure";
  const measureStart = tools.start;
  const measureEnd = tools.end;
  // Null until both ends are placed — one point is not yet a distance.
  const measurement = useMemo(() => measurementOf(tools), [tools]);
  const drivingParams = useMemo(
    () => ({
      startLat: measurement?.start.lat ?? 0,
      startLng: measurement?.start.lng ?? 0,
      endLat: measurement?.end.lat ?? 0,
      endLng: measurement?.end.lng ?? 0,
    }),
    [measurement],
  );
  const {
    data: drivingMeasurement,
    isLoading: drivingMeasurementLoading,
    isError: drivingMeasurementError,
  } = useGetMapDrivingRoute(drivingParams, {
    query: {
      enabled: measurement != null,
      retry: false,
      queryKey: getGetMapDrivingRouteQueryKey(drivingParams),
    },
  });
  const [dropping, setDropping] = useState(false);
  // Which job we've already parked the map on. Once a focus has been applied
  // the viewport belongs to the dispatcher: later refreshes redraw the pins
  // but must not drag the map back or reopen the card on top of their pan.
  const focusAppliedRef = useRef<number | null>(null);
  // The job we were sent to isn't on the map — usually no coordinates yet.
  const [focusMissing, setFocusMissing] = useState(false);
  /**
   * The address the "who's closest" panel is measuring from.
   *
   * Carries its own coordinates rather than an id into the current data: the
   * map reloads every 30 seconds and the dispatcher may well have switched to
   * tomorrow, and having the panel go blank under them mid-sentence is exactly
   * the moment they were about to phone somebody.
   */
  const [nearTarget, setNearTarget] = useState<NearTarget | null>(null);
  const [searchedTargets, setSearchedTargets] = useState<SearchedTarget[]>([]);
  const nextSearchOrdinalRef = useRef(1);
  const [selectedCleaner, setSelectedCleaner] =
    useState<ComparisonCleaner | null>(null);
  const [activeRouteId, setActiveRouteId] = useState<number | null>(null);

  const { data: activeRoute } = useGetSavedRoute(activeRouteId ?? 0, {
    query: {
      enabled: !!activeRouteId,
      queryKey: getGetSavedRouteQueryKey(activeRouteId ?? 0),
    },
  });

  /**
   * A cleaner chosen from a distance list becomes a complete, scratch
   * measurement — cleaner first, destination second. This replaces any armed
   * drop/move tool, stays entirely client-side, and frames both ends.
   */
  const compareCleanerToTarget = (
    cleaner: ComparisonCleaner,
    target: Pick<NearTarget, "lat" | "lng" | "label">,
  ) => {
    const start: MeasurePoint = {
      lat: cleaner.lat,
      lng: cleaner.lng,
      label: `${cleaner.name} (${cleaner.source === "live" ? "live" : "home"})`,
    };
    const end: MeasurePoint = {
      lat: target.lat,
      lng: target.lng,
      label: target.label,
    };
    setTools(setMeasurementPoints(start, end));
    infoWindowRef.current?.close();
    openMarkerRef.current = null;

    const map = mapRef.current;
    if (!maps || !map) return;
    const bounds = new maps.LatLngBounds();
    bounds.extend({ lat: start.lat, lng: start.lng });
    bounds.extend({ lat: end.lat, lng: end.lng });
    map.fitBounds(bounds, 96);
    const listener = map.addListener("idle", () => {
      listener.remove();
      const zoom = map.getZoom();
      if (zoom > MAX_FIT_ZOOM) map.setZoom(MAX_FIT_ZOOM);
      else if (zoom < MIN_FIT_ZOOM) map.setZoom(MIN_FIT_ZOOM);
    });
  };

  // Info-window buttons are created by the marker redraw effect and must call
  // the latest committed comparison handler without making tool state a redraw
  // dependency (which would tear every marker down when a point is chosen).
  const compareCleanerRef = useRef<
    (
      cleaner: ComparisonCleaner,
      target: Pick<NearTarget, "lat" | "lng" | "label">,
    ) => void
  >(() => {});
  useEffect(() => {
    compareCleanerRef.current = compareCleanerToTarget;
  });

  const selectedCleanerRef = useRef<ComparisonCleaner | null>(null);
  selectedCleanerRef.current = selectedCleaner;

  const chooseDestination = (target: NearTarget) => {
    setNearTarget(target);
    if (selectedCleanerRef.current) {
      compareCleanerRef.current(selectedCleanerRef.current, target);
    }
  };
  const chooseDestinationRef = useRef<(target: NearTarget) => void>(() => {});
  chooseDestinationRef.current = chooseDestination;
  const selectCleanerRef = useRef<(cleaner: ComparisonCleaner) => void>(
    () => {},
  );
  selectCleanerRef.current = setSelectedCleaner;

  const addSearchedTarget = (target: NearTarget) => {
    const ordinal = nextSearchOrdinalRef.current++;
    const searched: SearchedTarget = {
      ...target,
      origin: "search",
      searchId: ordinal,
      ordinal,
    };
    setSearchedTargets((current) => [...current, searched]);
    chooseDestination(searched);
  };

  // Google surfaces "key not authorized for Maps JS" ONLY through this global.
  // Without it the map silently greys out. Register it before the script runs.
  useEffect(() => {
    const prev = window.gm_authFailure;
    window.gm_authFailure = () => setAuthFailed(true);
    return () => {
      window.gm_authFailure = prev;
    };
  }, []);

  // Load the script once the runtime key is in hand.
  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps(apiKey)
      .then((api) => {
        if (!cancelled) setMaps(api);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [apiKey]);

  // Build the map exactly once the script is ready and the container exists.
  useEffect(() => {
    if (!maps || !mapContainerRef.current || mapRef.current) return;
    mapRef.current = new maps.Map(mapContainerRef.current, {
      center: HOME_CENTER,
      zoom: HOME_ZOOM,
      mapId: DEMO_MAP_ID,
      disableDefaultUI: false,
      clickableIcons: false,
    });
    infoWindowRef.current = new maps.InfoWindow();
    infoWindowRef.current.addListener?.("closeclick", () => {
      openMarkerRef.current = null;
    });
  }, [maps]);

  const dropPin = useCreateMapPin();
  const updatePin = useUpdateMapPin();
  const removePin = useDeleteMapPin();
  const addRouteStop = useAddSavedRouteStop();
  const refreshMap = useRefreshMap(mapParams);
  const { toast } = useToast();

  // The active lateness nudge: the poll a trail's projected arrival first
  // slips past booked time + grace, dispatch gets one toast — not another on
  // every 30-second refresh — and the cleaner's roster chip turns amber for
  // as long as the trail stays late. Same rule as the map's own chips
  // (etaSummary, inside the hook), so the two can never disagree. Cleaners
  // never get toasted about themselves — the hook gates and resets on role.
  const lateCleaners = useLateAlerts(
    routesData?.routes,
    timeZone,
    isDispatch,
    (msg) => toast({ ...msg, variant: "destructive" }),
  );

  // Dispatch-only pin surgery, driven from a pin's card on the map.
  // "Move" waits for the next map click; "Edit" opens the dialog below.
  const movingPin = tools.tool === "move" ? tools.movingPin : null;
  const [editingPin, setEditingPin] = useState<{
    id: number;
    name: string;
    address: string | null;
  } | null>(null);

  // The real lock. React state can't hold one: a double-click fires both
  // events before any re-render, so both would see `dropping === false` and
  // both would save. This flips synchronously, before any await.
  const dropInFlightRef = useRef(false);

  // Kept in a ref so the click listener below is attached once per drop-mode
  // session instead of being torn down and rebuilt on every render.
  const dropHandlerRef = useRef<(lat: number, lng: number) => void>(() => {});
  const handleDrop = (lat: number, lng: number) => {
    if (dropInFlightRef.current) return;
    dropInFlightRef.current = true;
    setDropping(true);
    void (async () => {
      const address = maps ? await reverseGeocode(maps, lat, lng) : null;
      // No street address (rural lot, or no Geocoding API on the key)? The
      // coordinates are a usable name — the pin is on the map either way.
      const label = address ?? `Pin at ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      dropPin.mutate(
        { data: { name: label, address, lat, lng } },
        {
          onSuccess: () => {
            refreshMap();
            const cleaner = selectedCleanerRef.current;
            if (cleaner) {
              compareCleanerRef.current(cleaner, {
                lat,
                lng,
                label,
              });
            }
            toast({
              title: "Pin dropped",
              description: address
                ? `${address} is now a saved location.${cleaner ? ` Comparing it with ${cleaner.name}.` : " Drop another, or press Esc when finished."}`
                : `Saved at the spot you clicked.${cleaner ? ` Comparing it with ${cleaner.name}.` : " Drop another, or press Esc when finished."}`,
            });
          },
          onError: (error: any) => {
            toast({
              title: "Couldn't drop that pin",
              description: pinErrorMessage(error),
              variant: "destructive",
            });
          },
          onSettled: () => {
            dropInFlightRef.current = false;
            setDropping(false);
          },
        },
      );
    })();
  };

  // Pin actions, reached from buttons built inside marker cards. Routed
  // through a ref so the marker-redraw effect never has to re-run just
  // because a mutation object got a new identity.
  const pinActionsRef = useRef({
    move: (_pin: { id: number; name: string }) => {},
    edit: (_pin: { id: number; name: string; address: string | null }) => {},
    remove: (_pin: { id: number; name: string }) => {},
  });
  pinActionsRef.current = {
    move: (pin) => {
      infoWindowRef.current?.close();
      // Arming the move puts drop mode and any measurement away by itself.
      setTools((s) => startMovingPin(s, pin));
      toast({
        title: `Moving "${pin.name}"`,
        description: "Click the map where it should go. Esc cancels.",
      });
    },
    edit: (pin) => {
      infoWindowRef.current?.close();
      setEditingPin(pin);
    },
    remove: (pin) => {
      infoWindowRef.current?.close();
      removePin.mutate(
        { id: pin.id },
        {
          onSuccess: () => {
            refreshMap();
            toast({
              title: "Pin removed",
              description: `${pin.name} removed.`,
            });
          },
          onError: (error: any) => {
            toast({
              title: "Couldn't remove that pin",
              description: pinErrorMessage(error),
              variant: "destructive",
            });
          },
        },
      );
    },
  };

  // A move in progress: the next map click is the pin's new home.
  const moveHandlerRef = useRef<(lat: number, lng: number) => void>(() => {});
  moveHandlerRef.current = (lat: number, lng: number) => {
    const pin = movingPin;
    if (!pin) return;
    setTools(cancelTool);
    void (async () => {
      const address = maps ? await reverseGeocode(maps, lat, lng) : null;
      updatePin.mutate(
        { id: pin.id, data: { lat, lng, address } },
        {
          onSuccess: () => {
            refreshMap();
            toast({
              title: "Pin moved",
              description: address
                ? `${pin.name} is now at ${address}.`
                : `${pin.name} moved to the spot you clicked.`,
            });
          },
          onError: (error: any) => {
            toast({
              title: "Couldn't move that pin",
              description: pinErrorMessage(error),
              variant: "destructive",
            });
          },
        },
      );
    })();
  };

  useEffect(() => {
    const map = mapRef.current;
    if (!maps || !map || !movingPin) return;
    const listener = map.addListener("click", (event: any) => {
      const lat = event?.latLng?.lat?.();
      const lng = event?.latLng?.lng?.();
      if (typeof lat === "number" && typeof lng === "number") {
        moveHandlerRef.current(lat, lng);
      }
    });
    map.setOptions({ draggableCursor: "crosshair" });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTools(cancelTool);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      listener.remove();
      map.setOptions({ draggableCursor: null });
      window.removeEventListener("keydown", onKey);
    };
  }, [maps, movingPin]);

  // Synchronised after commit, not during render: an interrupted render must
  // never leave the Maps listener holding a handler React hasn't committed.
  useEffect(() => {
    dropHandlerRef.current = handleDrop;
  });

  // Listen for map clicks only while drop mode is on, and put the crosshair
  // cursor up so it's obvious the next click does something.
  useEffect(() => {
    const map = mapRef.current;
    if (!maps || !map || !dropMode) return;
    const listener = map.addListener("click", (event: any) => {
      const lat = event?.latLng?.lat?.();
      const lng = event?.latLng?.lng?.();
      if (typeof lat === "number" && typeof lng === "number") {
        dropHandlerRef.current(lat, lng);
      }
    });
    map.setOptions({ draggableCursor: "crosshair" });
    return () => {
      listener.remove();
      map.setOptions({ draggableCursor: null });
    };
  }, [maps, dropMode]);

  // Escape backs out of drop mode — the same reflex as closing a dialog.
  useEffect(() => {
    if (!dropMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTools(cancelTool);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dropMode]);

  /**
   * A click while measuring — from the bare map below, or handed over by a
   * marker that was clicked instead (see `attach`). Returns whether the
   * measure tool took the click, so a marker knows not to open its card.
   *
   * Routed through a ref for the same reason the drop handler is: the marker
   * listeners are built once per redraw and must not be torn down every time
   * a point is placed.
   */
  const measureClickRef = useRef<(point: MeasurePoint) => boolean>(() => false);
  const routeAddClickRef = useRef<(point: MeasurePoint) => boolean>(
    () => false,
  );

  useEffect(() => {
    measureClickRef.current = (point: MeasurePoint) => {
      if (!measureMode) return false;
      setTools((s) => addMeasurePoint(s, point));
      return true;
    };
    routeAddClickRef.current = (point: MeasurePoint) => {
      if (tools.tool !== "route-add") return false;
      // Do reverse geocoding in the background to get address maybe
      setTools((s) => addRouteDraftPoint(s, point));
      return true;
    };
  });

  // Measure mode: crosshair cursor, clicks become measurement points, Escape
  // wipes the whole thing. Nothing here talks to the server.
  useEffect(() => {
    const map = mapRef.current;
    if (!maps || !map || !measureMode) return;
    const listener = map.addListener("click", (event: any) => {
      const lat = event?.latLng?.lat?.();
      const lng = event?.latLng?.lng?.();
      if (typeof lat === "number" && typeof lng === "number") {
        measureClickRef.current({ lat, lng, label: null });
      }
    });
    map.setOptions({ draggableCursor: "crosshair" });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTools(clearMeasurement);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      listener.remove();
      map.setOptions({ draggableCursor: null });
      window.removeEventListener("keydown", onKey);
    };
  }, [maps, measureMode]);

  // Route-add mode: crosshair cursor, clicks prompt for a stop name.
  useEffect(() => {
    const map = mapRef.current;
    if (!maps || !map || tools.tool !== "route-add") return;
    const listener = map.addListener("click", (event: any) => {
      const lat = event?.latLng?.lat?.();
      const lng = event?.latLng?.lng?.();
      if (typeof lat === "number" && typeof lng === "number") {
        routeAddClickRef.current({ lat, lng, label: null });
      }
    });
    map.setOptions({ draggableCursor: "crosshair" });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTools(cancelTool);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      listener.remove();
      map.setOptions({ draggableCursor: null });
      window.removeEventListener("keydown", onKey);
    };
  }, [maps, tools.tool]);

  const { located: locatedJobs, unlocated: unlocatedJobs } = useMemo(
    () => partitionJobsByCoords(mapData?.jobs ?? []),
    [mapData],
  );

  // Anything already on the map tells us roughly where this company works, so
  // address suggestions lead with nearby streets instead of same-named ones a
  // province away.
  const biasCenter = useMemo(() => {
    const anchor =
      (mapData?.cleaners ?? []).find(hasCoords) ??
      locatedJobs[0] ??
      (mapData?.pins ?? []).find(hasCoords);
    return anchor ? { lat: anchor.lat, lng: anchor.lng } : undefined;
  }, [mapData, locatedJobs]);

  const routeTeamMembers = useMemo(() => {
    const members = new Map<number, { id: number; name: string }>();
    for (const home of mapData?.staffHomes ?? []) {
      if (home.active) {
        members.set(home.teamMemberId, {
          id: home.teamMemberId,
          name: home.name,
        });
      }
    }
    for (const member of mapData?.staffWithoutHome ?? []) {
      if (member.active) {
        members.set(member.teamMemberId, {
          id: member.teamMemberId,
          name: member.name,
        });
      }
    }
    for (const cleaner of mapData?.cleaners ?? []) {
      if (!members.has(cleaner.teamMemberId)) {
        members.set(cleaner.teamMemberId, {
          id: cleaner.teamMemberId,
          name: cleaner.name,
        });
      }
    }
    return [...members.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [mapData]);

  // Focus dropped (the dispatcher moved the day or the view) — forget where we
  // parked, so normal framing resumes on the next redraw.
  useEffect(() => {
    if (focusJobId === null) {
      focusAppliedRef.current = null;
      setFocusMissing(false);
    }
  }, [focusJobId]);

  // Redraw markers whenever the data changes. Every marker + listener from the
  // previous render is torn down first, so refreshes never leak markers.
  useEffect(() => {
    if (!maps || !mapRef.current) return;
    const map = mapRef.current;
    const infoWindow = infoWindowRef.current;

    // Tear down the previous batch.
    for (const marker of markersRef.current) {
      if (marker.__listener) marker.__listener.remove();
      marker.map = null;
    }
    markersRef.current = [];
    if (openMarkerRef.current) {
      infoWindow?.close();
      openMarkerRef.current = null;
    }

    // The one shared decision of what gets drawn: hidden cleaners lose only
    // their live car, while homes and client jobs always stay. Unchecked saved
    // pins disappear. Pinned by unit tests in
    // mapMarkerSelection.test.ts.
    const visible = selectMapMarkers(
      {
        cleaners: mapData?.cleaners,
        jobs: locatedJobs,
        pins: mapData?.pins,
        staffHomes: mapData?.staffHomes,
      },
      hiddenCleaners,
      hiddenPins,
    );

    // Everything plotted, gathered so the opening view can be framed around
    // the bulk of it rather than around whichever pin is furthest out.
    const framePoints: Coords[] = [];
    // Set when the dispatcher arrived here from a booking's "Show on map".
    let focusTarget: {
      marker: any;
      html: string | HTMLElement;
    } | null = null;

    // Clicking a marker opens its card, and — for the places a crew gets sent
    // to — also points the "who's closest" panel at that address.
    //
    // While the measure tool is armed a marker click means something else
    // entirely: "measure from THIS", exactly where it stands and under the
    // name it already carries. The card would be in the way, so it is not
    // opened. The moment measuring stops, the same listener goes back to
    // normal — the ref answers false and nothing about the marker changed.
    const attach = (
      key: string,
      marker: any,
      content: string | HTMLElement,
      near?: NearTarget,
      point?: MeasurePoint,
      onClick?: () => void,
    ) => {
      marker.__listener = marker.addListener("gmp-click", () => {
        if (point && measureClickRef.current(point)) return;
        onClick?.();
        toggleMapMarkerCard({
          key,
          marker,
          content,
          map,
          infoWindow,
          openMarker: openMarkerRef,
        });
        if (near) chooseDestinationRef.current(near);
      });
      markersRef.current.push(marker);
    };

    /**
     * Turn the compare buttons generated inside a Google InfoWindow into real
     * map actions. The HTML helper owns safe rendering; this DOM owner owns the
     * event listeners and the exact cleaner/target coordinates.
     */
    const comparisonCard = (
      html: string,
      ranked: NearbyCleaner[],
      target: Pick<NearTarget, "lat" | "lng" | "label">,
    ): HTMLDivElement => {
      const wrap = document.createElement("div");
      wrap.innerHTML = html;
      for (const button of wrap.querySelectorAll<HTMLButtonElement>(
        "[data-crew-compare]",
      )) {
        const id = Number(button.dataset.crewCompare);
        const cleaner = ranked.find(
          (candidate) => candidate.teamMemberId === id,
        );
        if (!cleaner) continue;
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          compareCleanerRef.current(cleaner, target);
        });
      }
      return wrap;
    };

    const routeActionsRefCurrent = routeActionsRef.current;

    // Add "Add to route" button to a card if a route is active.
    const withRouteAction = (
      card: HTMLDivElement,
      target: Pick<NearTarget, "lat" | "lng" | "label"> & {
        address: string | null;
      },
    ): HTMLDivElement => {
      if (!routeActionsRefCurrent.activeRouteId) return card;
      const row = document.createElement("div");
      row.style.cssText =
        "margin-top:8px;padding-top:8px;border-top:1px solid #e5e7eb;";
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "Add to route";
      b.style.cssText =
        "font:600 11px sans-serif;padding:3px 9px;border-radius:6px;border:1px solid #8b5cf6;background:#f3e8ff;color:#6d28d9;cursor:pointer";
      b.addEventListener("click", () => {
        routeActionsRefCurrent.addStop(
          target.label,
          target.address,
          target.lat,
          target.lng,
        );
      });
      row.appendChild(b);
      card.appendChild(row);
      return card;
    };

    // Dispatch-only buttons riding under a saved pin's card. Built as real
    // DOM (not an HTML string) so the clicks reach React handlers.
    const pinActionRow = (pin: {
      id: number;
      name: string;
      address: string | null;
    }): HTMLDivElement => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:6px;margin-top:8px";
      const mk = (label: string, onClick: () => void, danger = false) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.style.cssText = `font:600 11px sans-serif;padding:3px 9px;border-radius:6px;border:1px solid ${
          danger ? "#dc2626" : "#d1d5db"
        };background:#fff;color:${danger ? "#dc2626" : "#111"};cursor:pointer`;
        b.addEventListener("click", onClick);
        row.appendChild(b);
      };
      mk("Move", () => pinActionsRef.current.move(pin));
      mk("Edit", () => pinActionsRef.current.edit(pin));
      mk("Delete", () => pinActionsRef.current.remove(pin), true);
      return row;
    };

    // "Hide on map" rides under every saved pin's card — any role, because
    // hiding is the same personal display choice as unchecking a cleaner on
    // the roster strip. The checkbox in the Saved locations panel brings the
    // pin back.
    const hidePinRow = (pinId: number, name: string): HTMLDivElement => {
      const row = document.createElement("div");
      row.style.cssText = "margin-top:6px";
      const b = document.createElement("button");
      b.type = "button";
      // textContent, never markup — pin names are user input.
      b.textContent = "Hide on map";
      b.setAttribute("aria-label", `Hide ${name} on the map`);
      b.style.cssText =
        "font:600 11px sans-serif;padding:3px 9px;border-radius:6px;border:1px solid #d1d5db;background:#fff;color:#111;cursor:pointer";
      b.addEventListener("click", () => {
        // Close first — the redraw tears down the anchor marker, and a card
        // floating over a pin that just vanished reads as a bug.
        infoWindow?.close();
        togglePinRef.current(pinId);
      });
      row.appendChild(b);
      return row;
    };

    // The roster strip's registry rebuilds with the markers themselves.
    cleanerMarkersRef.current = new Map();

    // Cleaners on the move — a car in their own colour, with their initials
    // riding on the corner. The car is what separates "where this person is
    // right now" from the house marker further down that never moves; the
    // colour is what says which person it is without opening anything.
    for (const c of visible.cleaners) {
      const stale = isStale(c.updatedAt);
      // Owner devices are forced bright yellow with a dark ring; everyone else
      // keeps their roster colour.
      const style = markerStyleFor(c);
      const carColor = style.fill;
      // Only named when the person is carrying more than one device — a lone
      // phone doesn't need a caption, but the boss's four pins do.
      const deviceLabel = deviceLabelFor(c, visible.cleaners);
      const el = document.createElement("div");
      el.style.cssText = `position:relative;width:34px;height:34px;border-radius:9999px;display:flex;align-items:center;justify-content:center;color:${style.ink};border:2px solid ${style.outline};box-shadow:0 1px 4px rgba(0,0,0,.4);background:${carColor};opacity:${
        stale ? "0.45" : "1"
      };`;
      el.innerHTML = carSvg();
      const tag = document.createElement("div");
      tag.style.cssText = `position:absolute;bottom:-6px;right:-8px;padding:0 4px;border-radius:8px;background:#fff;color:${style.outline};border:1px solid ${style.outline};font:700 9px/14px "Plus Jakarta Sans",sans-serif;`;
      tag.textContent = initials(c.name);
      el.appendChild(tag);
      if (deviceLabel) {
        const caption = document.createElement("div");
        // Dark ink on white, never the marker colour: yellow-on-white text is
        // the one thing that would undo the high-visibility marker.
        caption.style.cssText = `position:absolute;top:-14px;left:50%;transform:translateX(-50%);white-space:nowrap;max-width:110px;overflow:hidden;text-overflow:ellipsis;padding:0 5px;border-radius:7px;background:#fff;color:#111;border:1px solid ${style.outline};font:700 9px/14px "Plus Jakarta Sans",sans-serif;`;
        caption.textContent = deviceLabel;
        el.appendChild(caption);
      }
      const marker = new maps.AdvancedMarkerElement({
        map,
        position: { lat: c.lat, lng: c.lng },
        content: el,
        title: deviceLabel ? `${c.name} — ${deviceLabel}` : c.name,
        zIndex: 3,
      });
      const acc = accuracyLabel(c);
      // Where they're due next, if the server drew them a trail. Only a live
      // car gets the line — a stale one already says "last seen".
      const heading = stale ? undefined : routesByMember.get(c.teamMemberId);
      const cleanerHtml = `<div style="font-family:sans-serif;color:#111;min-width:150px">
          <div style="font-weight:700">${escapeHtml(c.name)}</div>
          ${
            deviceLabel
              ? `<div style="font-size:12px;color:#111;font-weight:600">${escapeHtml(
                  deviceLabel,
                )}</div>`
              : ""
          }
          <div style="font-size:12px;color:#555">Cleaner${
            acc ? ` · ${acc}` : ""
          }</div>
          <div style="font-size:12px;color:${
            stale ? "#b45309" : "#16a34a"
          };margin-top:2px">
            ${stale ? `Last seen ${lastSeenLabel(c.updatedAt)}` : "Live now"}
          </div>
          ${
            heading
              ? `<div style="font-size:12px;color:#374151;margin-top:2px">${escapeHtml(
                  headingLabel(heading, timeZone),
                )}</div>`
              : ""
          }
          ${directionsHtml(null, c.lat, c.lng)}
        </div>`;
      attach(
        `cleaner:${c.teamMemberId}:${c.deviceId ?? "person"}`,
        marker,
        cleanerHtml,
        undefined,
        {
          lat: c.lat,
          lng: c.lng,
          label: c.name,
        },
        () =>
          selectCleanerRef.current({
            teamMemberId: c.teamMemberId,
            name: c.name,
            lat: c.lat,
            lng: c.lng,
            source: "live",
          }),
      );
      // A fresh position is where a roster click should land; a stale car is
      // still drawn but the home marker below makes the better jump target.
      // Keyed by PERSON, because that's what the roster strip clicks: with
      // several devices the freshest one wins, so the click lands where they
      // most recently were rather than on a tablet left behind.
      if (!stale) {
        const existing = cleanerMarkersRef.current.get(c.teamMemberId);
        if (!existing || c.updatedAt > (existing.updatedAt ?? "")) {
          cleanerMarkersRef.current.set(c.teamMemberId, {
            marker,
            content: cleanerHtml,
            updatedAt: c.updatedAt,
          });
        }
      }
      framePoints.push({ lat: c.lat, lng: c.lng });
    }

    // Client properties — a pink map pin, the teardrop shape everyone already
    // reads as "a place", pointing at the address it belongs to. Deliberately
    // not the same shape as a person: crew are round, homes are houses, places
    // are pins.
    for (const j of visible.jobs) {
      const el = pinMarker("hsl(330,81%,55%)");
      // A place we've been to more than once says so on the pin itself —
      // otherwise every address looks like a one-off and the map loses the
      // one thing it knows about a regular client.
      if ((j.visits ?? 1) > 1) {
        const badge = document.createElement("div");
        badge.style.cssText = `position:absolute;top:-6px;right:-8px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#fff;color:hsl(330,81%,45%);border:1px solid hsl(330,81%,55%);font:700 10px/14px sans-serif;text-align:center;z-index:1;`;
        badge.textContent = j.visits! > 99 ? "99+" : String(j.visits);
        el.appendChild(badge);
      }
      // The crew, riding the pin itself: one disc per assigned cleaner in
      // their roster colour, so "who is on this job" is readable at a glance
      // without opening the card. An unassigned job wears nothing — a bare
      // pink pin is exactly the "nobody's on this yet" signal.
      const crew = crewChipsFor(j);
      const badges = crewBadgeRow(crew.chips, crew.extra);
      if (badges) el.appendChild(badges);
      // The pin someone clicked through to (from a booking's address) wears
      // its own address in a little box above the teardrop, and rides above
      // its neighbours — one glance says "this is the one you asked for".
      const isFocused = j.bookingId === focusJobId;
      if (isFocused) {
        el.appendChild(
          focusAddressTag(j.customerAddress ?? null, j.customerName),
        );
      }
      const marker = new maps.AdvancedMarkerElement({
        map,
        position: { lat: j.lat, lng: j.lng },
        content: el,
        // The hover title answers "who is on this?" before any clicking.
        title: `${j.customerName} — ${assigneeNames(j)}`,
        zIndex: isFocused ? 4 : 2,
      });
      const jobTarget = {
        label: j.customerName,
        lat: j.lat,
        lng: j.lng,
      };
      const ranked = nearestCleaners(jobTarget, mapData ?? {});
      const jobHtml = `<div style="font-family:sans-serif;color:#111;min-width:170px">
          <div style="font-weight:700">${escapeHtml(j.customerName)}</div>
          <div style="font-size:12px;color:#555">${escapeHtml(
            j.customerAddress || "Address not provided",
          )}</div>
          <div style="font-size:12px;color:#555;margin-top:2px">${escapeHtml(
            formatZoned(j.scheduledFor, timeZone),
          )} ${escapeHtml(zoneLabel(timeZone, new Date(j.scheduledFor)))}</div>
          <div style="font-size:12px;color:#555">Status: ${escapeHtml(
            j.status,
          )}</div>
          <div style="font-size:12px;color:#555;margin-top:2px">Crew: ${escapeHtml(
            assigneeNames(j),
          )}</div>
          ${closestCrewHtml(ranked, hiddenCleaners, {
            compare: true,
            bookHref: canEditPins
              ? (cleaner) =>
                  `/bookings/new?rebookId=${j.bookingId}&assign=${cleaner.teamMemberId}`
              : undefined,
          })}
          ${directionsHtml(j.customerAddress, j.lat, j.lng)}
          ${canEditPins ? editInBookingsHtml(j.bookingId) : ""}
        </div>`;
      const jobContent = withRouteAction(
        comparisonCard(jobHtml, ranked, jobTarget),
        { ...jobTarget, address: j.customerAddress ?? null },
      );
      attach(
        `job:${j.bookingId}`,
        marker,
        jobContent,
        {
          label: j.customerName,
          address: j.customerAddress ?? null,
          lat: j.lat,
          lng: j.lng,
          origin: "pin",
          bookingId: j.bookingId,
        },
        { lat: j.lat, lng: j.lng, label: j.customerName },
      );
      if (isFocused) {
        focusTarget = { marker, html: jobContent };
      }
      framePoints.push({ lat: j.lat, lng: j.lng });
    }

    // Pins someone dropped by hand are flags, never circles or teardrops.
    // The silhouette is the durable meaning: dispatch added this waypoint.
    for (const p of visible.pins) {
      const ordinal = droppedPinOrdinal(mapData?.pins ?? [], p.id);
      const color = droppedPinColor(ordinal);
      const el = waypointMarker(color, `P${ordinal}`);
      const marker = new maps.AdvancedMarkerElement({
        map,
        position: { lat: p.lat, lng: p.lng },
        content: el,
        title: `Dropped pin ${ordinal}: ${p.name}`,
        zIndex: 1,
      });
      const pinTarget = { label: p.name, lat: p.lat, lng: p.lng };
      const ranked = nearestCleaners(pinTarget, mapData ?? {});
      const pinHtml = `<div style="font-family:sans-serif;color:#111;min-width:150px">
          <div style="font-weight:700">${escapeHtml(p.name)}</div>
          <div style="font-size:12px;color:#555">${escapeHtml(
            p.address || "Saved location",
          )}</div>
          ${closestCrewHtml(ranked, hiddenCleaners, {
            compare: true,
            bookHref: canEditPins
              ? (cleaner) => `/bookings/new?assign=${cleaner.teamMemberId}`
              : undefined,
          })}
          ${directionsHtml(p.address, p.lat, p.lng)}
        </div>`;
      // Real DOM for every role: the hide button must reach a React handler.
      // The Move/Edit/Delete row stays dispatch-only; hiding is not, because
      // it's a personal display preference, not a change to the pin itself.
      const wrap = document.createElement("div");
      wrap.innerHTML = pinHtml;
      for (const button of wrap.querySelectorAll<HTMLButtonElement>(
        "[data-crew-compare]",
      )) {
        const id = Number(button.dataset.crewCompare);
        const cleaner = ranked.find(
          (candidate) => candidate.teamMemberId === id,
        );
        if (!cleaner) continue;
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          compareCleanerRef.current(cleaner, pinTarget);
        });
      }
      if (canEditPins) {
        wrap.appendChild(
          pinActionRow({ id: p.id, name: p.name, address: p.address ?? null }),
        );
      }
      wrap.appendChild(hidePinRow(p.id, p.name));
      const pinContent: HTMLElement = wrap;
      attach(
        `pin:${p.id}`,
        marker,
        pinContent,
        {
          label: p.name,
          address: p.address ?? null,
          lat: p.lat,
          lng: p.lng,
          origin: "pin",
        },
        { lat: p.lat, lng: p.lng, label: p.name },
      );
      framePoints.push({ lat: p.lat, lng: p.lng });
    }

    // Staff homes — a house in the crew member's own colour with their name on
    // a tag above it, so the map answers "whose house is that?" at a glance
    // instead of only when you click. Shown all the time: "who lives nearest
    // this job" is asked while planning tomorrow, when nobody is transmitting.
    for (const s of visible.staffHomes) {
      const color = colorForTeamMember(s.teamMemberId, s.color);
      const el = document.createElement("div");
      el.style.cssText = `display:flex;flex-direction:column;align-items:center;gap:2px;opacity:${
        s.active ? "1" : "0.5"
      };`;

      const tag = document.createElement("div");
      tag.style.cssText = `padding:0 6px;border-radius:9px;background:#fff;color:${color};border:1px solid ${color};font:700 10px/16px "Plus Jakarta Sans",sans-serif;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.35);`;
      // The name is set as text, never as markup — a crew member called
      // `<script>` is a silly edge case with a serious consequence.
      tag.textContent = shortName(s.name);

      // Solid colour with a white glyph — the same bold finish as the job
      // pins and live cars, so a cleaner's home stands out on the map instead
      // of washing out into the basemap the way a white circle did.
      const house = document.createElement("div");
      house.style.cssText = `width:30px;height:30px;border-radius:9999px;display:flex;align-items:center;justify-content:center;color:#fff;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);`;
      house.innerHTML = homeSvg();

      el.append(tag, house);
      const marker = new maps.AdvancedMarkerElement({
        map,
        position: { lat: s.lat, lng: s.lng },
        content: el,
        title: `${s.name} (home)`,
        zIndex: 1,
      });
      const homeHtml = `<div style="font-family:sans-serif;color:#111;min-width:150px">
          <div style="font-weight:700">${escapeHtml(s.name)}</div>
          <div style="font-size:12px;color:#555">${escapeHtml(
            s.roleLabel,
          )} · Home${s.active ? "" : " · Off roster"}</div>
          <div style="font-size:12px;color:#555;margin-top:2px">${escapeHtml(
            s.address || "Saved location",
          )}</div>
          ${directionsHtml(s.address, s.lat, s.lng)}
        </div>`;
      attach(`home:${s.teamMemberId}`, marker, homeHtml, undefined, {
        lat: s.lat,
        lng: s.lng,
        label: `${s.name} (home)`,
      });
      // The jump target when their phone isn't reporting fresh positions.
      if (!cleanerMarkersRef.current.has(s.teamMemberId)) {
        cleanerMarkersRef.current.set(s.teamMemberId, {
          marker,
          content: homeHtml,
        });
      }
      framePoints.push({ lat: s.lat, lng: s.lng });
    }

    // The office — the shop itself, a building parked for good on the stored
    // company spot. Its coordinates come from the server's saved location,
    // never from anything the office browser reported, so a refresh or a bad
    // geolocation reading can't move it. Not part of the roster's hide list:
    // it is a place, like the pins, not a crew member.
    const office = mapData?.office;
    if (office) {
      const marker = new maps.AdvancedMarkerElement({
        map,
        position: { lat: office.lat, lng: office.lng },
        content: officeMarker(office.label),
        title: office.label,
        zIndex: 2,
      });
      const officeTarget = {
        label: office.label,
        lat: office.lat,
        lng: office.lng,
      };
      const ranked = nearestCleaners(officeTarget, mapData ?? {});
      const officeHtml = `<div style="font-family:sans-serif;color:#111;min-width:150px">
          <div style="font-weight:700">${escapeHtml(office.label)}</div>
          <div style="font-size:12px;color:#555">Office · always here</div>
          <div style="font-size:12px;color:#555;margin-top:2px">${escapeHtml(
            office.address || "Saved location",
          )}</div>
          ${closestCrewHtml(ranked, hiddenCleaners, {
            compare: true,
            bookHref: canEditPins
              ? (cleaner) => `/bookings/new?assign=${cleaner.teamMemberId}`
              : undefined,
          })}
          ${directionsHtml(office.address, office.lat, office.lng)}
        </div>`;
      const officeContent = withRouteAction(
        comparisonCard(officeHtml, ranked, officeTarget),
        { ...officeTarget, address: office.address ?? null },
      );
      attach(
        "office",
        marker,
        officeContent,
        {
          label: office.label,
          address: office.address ?? null,
          lat: office.lat,
          lng: office.lng,
          origin: "pin",
        },
        { lat: office.lat, lng: office.lng, label: office.label },
      );
      framePoints.push({ lat: office.lat, lng: office.lng });
    }

    const alreadyParked =
      focusJobId !== null && focusAppliedRef.current === focusJobId;
    setFocusMissing(focusJobId !== null && !focusTarget && !alreadyParked);

    if (alreadyParked) {
      // Pins were redrawn; the view stays exactly where the dispatcher left it.
    } else if (focusTarget) {
      // One job was asked for by name — sit on it with its card open, rather
      // than framing the whole day and leaving the dispatcher to hunt.
      const target: { marker: any; html: string | HTMLElement } = focusTarget;
      map.setCenter(target.marker.position);
      map.setZoom(FOCUS_ZOOM);
      infoWindow.setContent(target.html);
      infoWindow.open({ map, anchor: target.marker });
      openMarkerRef.current = `job:${focusJobId}`;
      focusAppliedRef.current = focusJobId;
    } else if (framePoints.length > 0) {
      const bounds = new maps.LatLngBounds();
      for (const point of pointsToFrame(framePoints)) bounds.extend(point);
      map.fitBounds(bounds, 64);
      // fitBounds settles asynchronously, so the clamps have to wait for it.
      const listener = map.addListener("idle", () => {
        listener.remove();
        const zoom = map.getZoom();
        if (zoom > MAX_FIT_ZOOM) map.setZoom(MAX_FIT_ZOOM);
        else if (zoom < MIN_FIT_ZOOM) map.setZoom(MIN_FIT_ZOOM);
      });
    } else {
      // Nothing to show for this day — sit over the service area rather than
      // wherever the dispatcher last dragged the map to.
      map.setCenter(HOME_CENTER);
      map.setZoom(HOME_ZOOM);
    }
  }, [
    maps,
    mapData,
    locatedJobs,
    timeZone,
    focusJobId,
    hiddenCleaners,
    hiddenPins,
    routesByMember,
    // The role gate arrives with /me, usually after the first draw. Cards
    // bake dispatch-only Edit in Bookings and pin actions into their HTML, so
    // the redraw must re-run when it resolves —
    // otherwise an owner's first-loaded map stays read-only until something
    // else happens to redraw.
    canEditPins,
  ]);

  // Trails: the coloured line from each live cleaner to their next job, a
  // dot on that destination, and an ETA chip riding the middle of the line.
  // Kept out of the marker rebuild above so the two never fight — this
  // effect owns its own teardown and never touches the info window.
  useEffect(() => {
    if (!maps || !mapRef.current || !maps.Polyline) return;
    const map = mapRef.current;
    const lines: any[] = [];
    const overlays: any[] = [];

    // Switched off, the effect still runs and still tears down: that is what
    // clears lines already on the map the moment the owner flips it.
    const trails = showTrails
      ? visibleTrails(routesData?.routes ?? [], hiddenCleaners)
      : [];
    for (const r of trails) {
      const color = colorForTeamMember(r.teamMemberId, r.color);
      const path = r.path.map((p) => ({ lat: p.lat, lng: p.lng }));
      // A real driving route is a solid line; the straight-line estimate is
      // dashed, the map's own way of saying "roughly".
      const dashed = r.source === "estimate";
      lines.push(
        new maps.Polyline({
          map,
          path,
          strokeColor: color,
          // Dashes are drawn as repeated symbols over an invisible stroke.
          strokeOpacity: dashed ? 0 : 0.75,
          strokeWeight: 4,
          zIndex: 1,
          ...(dashed
            ? {
                icons: [
                  {
                    icon: {
                      path: "M 0,-1 0,1",
                      strokeOpacity: 0.75,
                      strokeColor: color,
                      strokeWeight: 3,
                      scale: 3,
                    },
                    offset: "0",
                    repeat: "14px",
                  },
                ],
              }
            : {}),
        }),
      );

      // A small dot where the trail ends. On the day view the pink job pin
      // stands on the same spot; on any other view the dot is what says
      // where this cleaner is heading.
      const dot = document.createElement("div");
      dot.style.cssText = `width:12px;height:12px;border-radius:9999px;background:${color};border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4);`;
      overlays.push(
        new maps.AdvancedMarkerElement({
          map,
          position: { lat: r.destLat, lng: r.destLng },
          content: dot,
          title: `${r.name} → ${r.customerName}`,
          zIndex: 1,
        }),
      );

      // The ETA chip rides the middle of the line, deliberately unclickable
      // so it never steals a tap meant for the pin underneath.
      const mid = midpointOf(path);
      if (mid) {
        const chip = document.createElement("div");
        chip.style.cssText = `pointer-events:none;padding:2px 8px;border-radius:9999px;background:#fff;color:#111;border:1.5px solid ${color};font:700 11px/16px "Plus Jakarta Sans",sans-serif;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.35);`;
        chip.textContent = chipLabel(r, timeZone);
        overlays.push(
          new maps.AdvancedMarkerElement({
            map,
            position: mid,
            content: chip,
            zIndex: 2,
          }),
        );
      }
    }

    return () => {
      for (const line of lines) line.setMap(null);
      for (const overlay of overlays) overlay.map = null;
    };
  }, [maps, routesData, hiddenCleaners, showTrails, timeZone]);

  // Draw the active route (lines and stops)
  useEffect(() => {
    if (!maps || !mapRef.current || !maps.Polyline) return;
    const map = mapRef.current;

    // Clear old route elements
    for (const marker of routeMarkersRef.current) {
      if (marker.__listener) marker.__listener.remove();
      marker.map = null;
    }
    routeMarkersRef.current = [];
    for (const line of routeLinesRef.current) line.setMap(null);
    routeLinesRef.current = [];

    if (!activeRoute) return;

    // Find the assigned cleaner's location (live or home)
    const cleaner = mapData?.cleaners?.find(
      (c) => c.teamMemberId === activeRoute.teamMemberId,
    );
    let startPoint: MeasurePoint | null = null;
    if (cleaner) {
      startPoint = { lat: cleaner.lat, lng: cleaner.lng, label: cleaner.name };
    } else {
      const home = mapData?.staffHomes?.find(
        (h) => h.teamMemberId === activeRoute.teamMemberId,
      );
      if (home) startPoint = { lat: home.lat, lng: home.lng, label: home.name };
    }

    const stops: RoutePlanStop[] = activeRoute.stops.map((s) => ({
      id: s.id,
      position: s.position,
      name: s.name,
      lat: s.lat,
      lng: s.lng,
      label: s.name,
    }));

    if (startPoint && stops.length > 0) {
      const legs = routePlanLegs(startPoint, stops);
      const color = colorForTeamMember(activeRoute.teamMemberId, null);

      for (const leg of legs) {
        // Dashed straight-line leg
        const path = [leg.from, leg.to];
        const line = new maps.Polyline({
          map,
          path,
          strokeColor: color,
          strokeOpacity: 0,
          strokeWeight: 4,
          zIndex: 1,
          icons: [
            {
              icon: {
                path: "M 0,-1 0,1",
                strokeOpacity: 0.75,
                strokeColor: color,
                strokeWeight: 3,
                scale: 3,
              },
              offset: "0",
              repeat: "14px",
            },
          ],
        });
        routeLinesRef.current.push(line);

        // Distance chip
        const mid = midpointOf(path);
        if (mid) {
          const chip = document.createElement("div");
          chip.style.cssText = `pointer-events:none;padding:2px 8px;border-radius:9999px;background:#fff;color:#111;border:1.5px solid ${color};font:700 11px/16px "Plus Jakarta Sans",sans-serif;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.35);`;
          chip.textContent = `${leg.drive} est.`;
          routeMarkersRef.current.push(
            new maps.AdvancedMarkerElement({
              map,
              position: mid,
              content: chip,
              zIndex: 2,
            }),
          );
        }
      }
    }

    // Draw flags for route stops
    const color = colorForTeamMember(activeRoute.teamMemberId, null);
    stops.forEach((stop, index) => {
      const badge = `R${index + 1}`;
      const el = waypointMarker(color, badge);
      const marker = new maps.AdvancedMarkerElement({
        map,
        position: { lat: stop.lat, lng: stop.lng },
        content: el,
        title: stop.name,
        zIndex: 5,
      });

      // Clicking a route stop opens an info window
      const html = `<div style="font-family:sans-serif;color:#111;min-width:180px">
        <div style="font-weight:700;margin-bottom:4px">${escapeHtml(stop.name)}</div>
        <div style="font-size:12px;color:#555;">Route stop ${badge}</div>
        ${directionsHtml(null, stop.lat, stop.lng)}
      </div>`;

      const wrap = document.createElement("div");
      wrap.innerHTML = html;

      const listener = marker.addListener("gmp-click", () => {
        if (!infoWindowRef.current) return;
        // Don't open if measurement tool is armed
        if (measureClickRef.current(stop)) return;
        if (routeAddClickRef.current(stop)) return;

        toggleMapMarkerCard({
          key: `route-stop:${activeRoute.id}:${stop.id}`,
          marker,
          content: wrap,
          map,
          infoWindow: infoWindowRef.current,
          openMarker: openMarkerRef,
        });
      });
      marker.__listener = listener;
      routeMarkersRef.current.push(marker);
    });
  }, [maps, mapData, activeRoute, timeZone]);

  /**
   * The measurement itself, drawn: two lettered ends and, once Google answers,
   * the actual driving polyline with the routed distance riding on it.
   *
   * Its own effect with its own teardown, like the trails above — the marker
   * rebuild reframes the map and closes the open card, and a measurement must
   * survive the 30-second refresh that redraws every pin under it. Nothing
   * here is saved: the overlay is built from component state and dies with
   * it, whether that's the Clear button, Escape, another tool, or leaving the
   * page.
   */
  useEffect(() => {
    if (!maps || !mapRef.current) return;
    const map = mapRef.current;
    const overlays: any[] = [];
    const lines: any[] = [];
    const ends: Array<[MeasurePoint | null, string]> = [
      [measureStart, "A"],
      [measureEnd, "B"],
    ];
    for (const [point, letter] of ends) {
      if (!point) continue;
      overlays.push(
        new maps.AdvancedMarkerElement({
          map,
          position: { lat: point.lat, lng: point.lng },
          content: measureEndpoint(letter),
          title: measurePointLabel(point, `Point ${letter}`),
          // Above every saved marker: it's the thing being placed right now.
          zIndex: 5,
        }),
      );
    }

    if (measurement && drivingMeasurement && maps.Polyline) {
      const path = drivingMeasurement.path.map((point) => ({
        lat: point.lat,
        lng: point.lng,
      }));
      lines.push(
        new maps.Polyline({
          map,
          path,
          strokeColor: MEASURE_COLOR,
          strokeOpacity: 0.9,
          strokeWeight: 4,
          zIndex: 4,
        }),
      );
      const mid = midpointOf(path);
      if (mid) {
        const labels = formatDrivingMeasurement(
          drivingMeasurement.distanceMeters,
          drivingMeasurement.durationSeconds,
        );
        overlays.push(
          new maps.AdvancedMarkerElement({
            map,
            position: mid,
            content: measureChip(
              `${labels.distance} driving · ${labels.duration}`,
            ),
            zIndex: 5,
          }),
        );
      }
    }

    return () => {
      for (const line of lines) line.setMap(null);
      for (const overlay of overlays) overlay.map = null;
    };
  }, [maps, measureStart, measureEnd, measurement, drivingMeasurement]);

  /**
   * A roster click: pan to that cleaner and open their card. Runs after the
   * redraw effect above (declared later), so the registry is already rebuilt
   * — including the case where the click also re-checked a hidden cleaner in
   * the same commit. Object identity in `cleanerFocus` means a 30-second data
   * refresh never re-yanks the map back here.
   */
  useEffect(() => {
    if (!maps || !mapRef.current || !cleanerFocus) return;
    const map = mapRef.current;
    const entry = cleanerMarkersRef.current.get(cleanerFocus.teamMemberId);
    if (entry) {
      map.setCenter(entry.marker.position);
      map.setZoom(FOCUS_ZOOM);
      infoWindowRef.current?.setContent(entry.content);
      infoWindowRef.current?.open({ map, anchor: entry.marker });
      openMarkerRef.current = `cleaner:${cleanerFocus.teamMemberId}`;
    } else {
      // No marker (e.g. only a stale position with no home saved) — still
      // take the dispatcher to the spot rather than doing nothing.
      map.setCenter({ lat: cleanerFocus.lat, lng: cleanerFocus.lng });
      map.setZoom(FOCUS_ZOOM);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanerFocus]);

  /**
   * The pin for an address someone typed into "who's closest".
   *
   * Kept out of the marker rebuild above deliberately: that effect reframes the
   * map and closes the open card, so folding a click-selected target into it
   * would slam shut the very info window the dispatcher just opened.
   */
  useEffect(() => {
    if (!maps || !mapRef.current) return;
    const map = mapRef.current;
    for (const marker of searchMarkersRef.current) {
      if (marker.__listener) marker.__listener.remove();
      marker.map = null;
    }
    searchMarkersRef.current = [];
    for (const target of searchedTargets) {
      const color = droppedPinColor(target.ordinal);
      const el = waypointMarker(color, `S${target.ordinal}`);
      el.style.filter = "drop-shadow(0 0 3px rgba(255,255,255,.9))";
      const marker = new maps.AdvancedMarkerElement({
        map,
        position: { lat: target.lat, lng: target.lng },
        content: el,
        title: `Searched destination ${target.ordinal}: ${target.label}`,
        zIndex: 4,
      });
      marker.__listener = marker.addListener("gmp-click", () => {
        chooseDestinationRef.current(target);
        if (!infoWindowRef.current) return;
        toggleMapMarkerCard({
          key: `search:${target.searchId}`,
          marker,
          content: `<div style="font-family:sans-serif;color:#111;min-width:170px">
            <div style="font-weight:700">${escapeHtml(target.label)}</div>
            <div style="font-size:12px;color:#555">Searched destination S${target.ordinal}</div>
            ${directionsHtml(target.address, target.lat, target.lng)}
          </div>`,
          map,
          infoWindow: infoWindowRef.current,
          openMarker: openMarkerRef,
        });
      });
      searchMarkersRef.current.push(marker);
    }
    const latest = searchedTargets[searchedTargets.length - 1];
    if (latest) map.panTo({ lat: latest.lat, lng: latest.lng });
  }, [maps, searchedTargets]);

  // Final cleanup on unmount — no markers, listeners or info window left behind.
  useEffect(() => {
    return () => {
      for (const marker of markersRef.current) {
        if (marker.__listener) marker.__listener.remove();
        marker.map = null;
      }
      markersRef.current = [];
      for (const marker of searchMarkersRef.current) {
        if (marker.__listener) marker.__listener.remove();
        marker.map = null;
      }
      searchMarkersRef.current = [];
      for (const marker of routeMarkersRef.current) {
        if (marker.__listener) marker.__listener.remove();
        marker.map = null;
      }
      routeMarkersRef.current = [];
      for (const line of routeLinesRef.current) line.setMap(null);
      routeLinesRef.current = [];
      if (infoWindowRef.current) infoWindowRef.current.close();
    };
  }, []);

  return (
    <div className="space-y-4">
      {/* The address search sits at the very top: dispatch's first move is
          usually "where is this customer?", and that shouldn't need scrolling
          past the map to a sidebar. A cleaner gets the same bar with only the
          measure tool in it — measuring saves nothing, so there is nothing to
          keep them out of. */}
      <MapToolbar
        bias={biasCenter}
        mapParams={mapParams}
        canEditPins={canEditPins}
        dropMode={dropMode}
        dropping={dropping}
        tools={tools}
        measurement={measurement}
        drivingMeasurement={drivingMeasurement}
        drivingMeasurementLoading={drivingMeasurementLoading}
        drivingMeasurementError={drivingMeasurementError}
        onToggleDropMode={() => setTools(toggleDropMode)}
        onToggleMeasure={() => setTools(toggleMeasureMode)}
        onClearMeasure={() => setTools(clearMeasurement)}
      />

      {isOwner ? <DeviceManager /> : null}

      {canEditPins && (
        <EditPinDialog
          pin={editingPin}
          pending={updatePin.isPending}
          onClose={() => setEditingPin(null)}
          onSave={(changes) => {
            const pin = editingPin;
            if (!pin) return;
            updatePin.mutate(
              { id: pin.id, data: changes },
              {
                onSuccess: () => {
                  setEditingPin(null);
                  refreshMap();
                  toast({
                    title: "Pin updated",
                    description: `${changes.name ?? pin.name} saved.`,
                  });
                },
                onError: (error: any) => {
                  toast({
                    title: "Couldn't update that pin",
                    description: pinErrorMessage(error),
                    variant: "destructive",
                  });
                },
              },
            );
          }}
        />
      )}

      <RouteAddDialog
        maps={maps}
        draft={tools.routeAddDraft ?? null}
        pending={addRouteStop.isPending}
        onClose={() => setTools(clearRouteAddDraft)}
        onSave={(name, address) => {
          if (!activeRouteId || !tools.routeAddDraft) return;
          addRouteStop.mutate(
            {
              id: activeRouteId,
              data: {
                name,
                address: address || null,
                lat: tools.routeAddDraft.lat,
                lng: tools.routeAddDraft.lng,
              },
            },
            {
              onSuccess: () => {
                setTools(clearRouteAddDraft);
                queryClient.invalidateQueries({
                  queryKey: getGetSavedRouteQueryKey(activeRouteId),
                });
                toast({ title: "Stop added to route" });
              },
              onError: (error: any) => {
                toast({
                  title: "Couldn't add stop",
                  description: error.message,
                  variant: "destructive",
                });
              },
            },
          );
        }}
      />

      {calendar}

      {authFailed && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-amber-300">
              Google rejected the Maps key
            </p>
            <p className="text-amber-200/80 mt-1">
              The map can&apos;t draw because this key isn&apos;t authorized for
              the <strong>Maps JavaScript API</strong>. Enable Maps JavaScript
              API (and Geocoding API for adding pins by address) in Google Cloud
              for this key, then refresh.
            </p>
          </div>
        </div>
      )}

      {mapData?.livePositions && !mapData.livePositions.allowed && (
        <div
          className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200"
          role="status"
          data-testid="live-location-withheld"
        >
          Live crew locations are temporarily withheld.{" "}
          {mapData.livePositions.reason}
        </div>
      )}

      {focusMissing && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/25 text-xs text-amber-200/90">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
          <span>
            That job isn&apos;t pinned on this map yet — we don&apos;t have a
            location for its address, or it isn&apos;t one of yours. Everything
            else for these dates is still shown.{" "}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => onFocusResolved(null)}
            >
              Dismiss
            </button>
          </span>
        </div>
      )}

      {(isRangeView || showAllPins) && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-brand-purple/10 border border-brand-purple/25 text-xs text-muted-foreground">
          <MapPin className="w-3.5 h-3.5 text-brand-purple shrink-0" />
          {showAllPins ? (
            <span>
              Showing every address you&apos;ve worked at —{" "}
              <span className="font-semibold text-foreground">
                {locatedJobs.length}
              </span>{" "}
              location{locatedJobs.length === 1 ? "" : "s"}, one pin per place
              however many times you&apos;ve been — plus your cleaners&apos;
              homes and anyone currently on the move. The calendar below still
              follows the dates you picked.
            </span>
          ) : (
            <span>
              The map below shows all{" "}
              <span className="font-semibold text-foreground">
                {locatedJobs.length}
              </span>{" "}
              pinned job{locatedJobs.length === 1 ? "" : "s"} from{" "}
              <span className="font-semibold text-foreground">
                {rangeLabel}
              </span>{" "}
              — tap a pin for its date and crew.
            </span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between text-xs text-muted-foreground gap-x-4 gap-y-2">
        <Legend measuring={measureMode} hasOffice={Boolean(mapData?.office)} />
        <div className="flex items-center gap-4">
          {/* The boss's own view switch: the lines running from each cleaner
              to their next job can be a lot on a busy morning. His choice
              only, and only his own screen — a dispatcher's map is unchanged
              by what he switches off here. */}
          {isOwner && (
            <label
              className="flex items-center gap-2 cursor-pointer select-none"
              data-testid="label-show-trails"
            >
              <Switch
                checked={showTrails}
                onCheckedChange={setShowTrails}
                data-testid="switch-show-trails"
              />
              <span>Trails</span>
            </label>
          )}
          <span>
            {isFetching
              ? "Refreshing…"
              : lastUpdated
                ? `Last updated ${new Date(lastUpdated).toLocaleTimeString()}`
                : ""}
          </span>
        </div>
      </div>

      {/* One chip per active cleaner: click a name to jump to them, uncheck to
          hide only their live car and trail. Homes and place markers stay. */}
      <CleanerRoster
        data={mapData}
        hidden={hiddenCleaners}
        late={lateCleaners}
        onToggle={toggleCleaner}
        onShowAll={showAllCleaners}
        onHideAll={hideAllCleaners}
        onFocus={(c: RosterCleaner) => {
          // A click on a hidden cleaner both reveals and jumps to them —
          // panning to an invisible marker would look like a broken click.
          showCleaner(c.teamMemberId);
          setCleanerFocus({
            teamMemberId: c.teamMemberId,
            lat: c.focus!.lat,
            lng: c.focus!.lng,
          });
          if (c.focus) {
            setSelectedCleaner({
              teamMemberId: c.teamMemberId,
              name: c.name,
              lat: c.focus.lat,
              lng: c.focus.lng,
              source: c.focus.source,
            });
          }
        }}
        {...(selectedCleaner
          ? {
              highlighted: selectedCleaner.teamMemberId,
              onClearHighlight: () => setSelectedCleaner(null),
            }
          : {})}
      />

      {selectedCleaner && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-brand-blue/35 bg-brand-blue/10 px-3 py-2 text-sm"
          data-testid="selected-cleaner-dispatch"
        >
          <span>
            <strong>{selectedCleaner.name}</strong> selected for dispatch. Click
            a job or numbered pin, search an address, or use Drop a pin to
            compare the route. No booking changes until you choose Book.
          </span>
          <button
            type="button"
            className="text-xs font-semibold text-brand-blue underline underline-offset-2"
            onClick={() => setSelectedCleaner(null)}
          >
            Clear selection
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-card border border-border rounded-xl shadow-sm overflow-hidden relative min-h-[420px]">
          {loadError && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-card p-8 text-center">
              <p className="text-sm text-muted-foreground max-w-sm">
                We couldn&apos;t load Google Maps. Check your connection and
                refresh.
              </p>
            </div>
          )}
          {!maps && !loadError && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-card">
              <LoadingSpinner />
            </div>
          )}
          <div ref={mapContainerRef} className="w-full h-[420px] lg:h-full" />
        </div>

        <div className="space-y-4">
          {canEditPins && (
            <SavedRoutesPanel
              activeRouteId={activeRouteId}
              onSelectRoute={setActiveRouteId}
              teamMembers={routeTeamMembers}
              mapData={mapData}
              routeAddMode={tools.tool === "route-add"}
              onToggleRouteAddMode={() => setTools(toggleRouteAddMode)}
            />
          )}
          <ClosestCrew
            target={nearTarget}
            mapData={mapData}
            hiddenCleaners={hiddenCleaners}
            bias={biasCenter}
            searchedTargets={searchedTargets}
            onSearch={addSearchedTarget}
            onClear={() => setNearTarget(null)}
            onSelectSearch={chooseDestination}
            onRemoveSearch={(searchId) => {
              setSearchedTargets((current) =>
                current.filter((target) => target.searchId !== searchId),
              );
              setNearTarget((current) =>
                current?.origin === "search" && current.searchId === searchId
                  ? null
                  : current,
              );
            }}
            onClearSearches={() => {
              setSearchedTargets([]);
              setNearTarget((current) =>
                current?.origin === "search" ? null : current,
              );
            }}
            onCompare={compareCleanerToTarget}
            canBook={canEditPins}
            activeRouteId={activeRouteId}
            onAddStop={(target) => {
              if (!activeRouteId) return;
              addRouteStop.mutate(
                {
                  id: activeRouteId,
                  data: {
                    name: target.label || "New stop",
                    address: target.address,
                    lat: target.lat,
                    lng: target.lng,
                  },
                },
                {
                  onSuccess: () => {
                    queryClient.invalidateQueries({
                      queryKey: getGetSavedRouteQueryKey(activeRouteId),
                    });
                    toast({ title: "Stop added to route" });
                  },
                },
              );
            }}
          />
          <SavedPins
            pins={mapData?.pins ?? []}
            mapParams={mapParams}
            canEdit={canEditPins}
            hiddenPins={hiddenPins}
            onTogglePin={togglePin}
            activeRouteId={activeRouteId}
            onAddStop={(pin) => {
              if (!activeRouteId) return;
              addRouteStop.mutate(
                {
                  id: activeRouteId,
                  data: {
                    name: pin.name,
                    address: pin.address ?? null,
                    lat: pin.lat,
                    lng: pin.lng,
                  },
                },
                {
                  onSuccess: () => {
                    queryClient.invalidateQueries({
                      queryKey: getGetSavedRouteQueryKey(activeRouteId),
                    });
                    toast({ title: "Stop added to route" });
                  },
                },
              );
            }}
          />
          {unlocatedJobs.length > 0 && (
            <div className="bg-card border border-border rounded-xl shadow-sm p-4">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-2">
                <Briefcase className="w-4 h-4 text-muted-foreground" />
                Not yet located ({unlocatedJobs.length})
              </h3>
              <p className="text-xs text-muted-foreground mb-3">
                These jobs have no map coordinates yet, so they can&apos;t be
                pinned.
              </p>
              <ul className="space-y-2">
                {unlocatedJobs.map((j) => (
                  <li
                    key={j.bookingId}
                    className="text-sm border-b border-border/60 pb-2 last:border-0 last:pb-0"
                  >
                    <div className="font-medium text-foreground">
                      {j.customerName}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {j.customerAddress || "Address not provided"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatZoned(j.scheduledFor, timeZone)}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** A place the crew could be sent to, and the address to say it by. */
type NearTarget = {
  label: string;
  address: string | null;
  lat: number;
  lng: number;
  /**
   * A searched address has no pin of its own, so the map draws it one. Anything
   * clicked is already on the map and must not be doubled up.
   */
  origin: "pin" | "search";
  /** Existing jobs can prefill their stored client fields in a new booking. */
  bookingId?: number | null;
  searchId?: number;
};

type SearchedTarget = NearTarget & {
  origin: "search";
  searchId: number;
  ordinal: number;
};

type ComparisonCleaner = Pick<
  NearbyCleaner,
  "teamMemberId" | "name" | "lat" | "lng" | "source"
>;

/** Names to spell out before "and N more" in the missing-address warning. */
const NAMES_IN_WARNING = 3;

/**
 * Who to send, ranked by how far they are from the place on the map.
 *
 * Recomputed from the live data on every render rather than frozen when the
 * pin was clicked, so a cleaner who moves closer while the dispatcher is
 * looking at the panel moves up it.
 */
export function ClosestCrew({
  target,
  mapData,
  hiddenCleaners,
  bias,
  onSearch,
  onClear,
  searchedTargets = [],
  onSelectSearch,
  onRemoveSearch,
  onClearSearches,
  onCompare,
  canBook = false,
  activeRouteId,
  onAddStop,
}: {
  target: NearTarget | null;
  mapData: MapData | undefined;
  /** The roster strip's hide set — hidden people stay ranked, just labelled. */
  hiddenCleaners: Set<number>;
  bias?: { lat: number; lng: number };
  onSearch: (target: NearTarget) => void;
  onClear: () => void;
  searchedTargets?: SearchedTarget[];
  onSelectSearch?: (target: SearchedTarget) => void;
  onRemoveSearch?: (searchId: number) => void;
  onClearSearches?: () => void;
  onCompare: (cleaner: ComparisonCleaner, target: NearTarget) => void;
  canBook?: boolean;
  activeRouteId?: number | null;
  onAddStop?: (target: NearTarget) => void;
}) {
  const { toast } = useToast();
  const [address, setAddress] = useState("");
  const [looking, setLooking] = useState(false);
  // Raw mapData on purpose — the hide list is a display preference, not an
  // availability filter; distances must reflect geography. See nearest.ts.
  const ranked = useMemo(
    () => (target ? nearestCleaners(target, mapData ?? {}) : []),
    [target, mapData],
  );

  // Only the crew currently on the roster: someone off this week with no
  // address is not a gap worth nagging about.
  const missingHomes = useMemo(
    () => (mapData?.staffWithoutHome ?? []).filter((s) => s.active),
    [mapData],
  );
  const missingHomeNames = useMemo(() => {
    const names = missingHomes.map((s) => s.name);
    return names.length > NAMES_IN_WARNING
      ? `${names.slice(0, NAMES_IN_WARNING).join(", ")} and ${names.length - NAMES_IN_WARNING} more`
      : names.join(", ");
  }, [missingHomes]);

  // Measure from any address at all — a caller who hasn't booked yet, a house
  // being quoted, an address read off a text message. Nothing is saved.
  const look = async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed || looking) return;
    setLooking(true);
    try {
      // Send the area this company works in with the question: without it a
      // bare street name matches just as well in another province, and Google
      // answers with the far one rather than an error.
      const found = await geocodeMapAddress({
        address: trimmed,
        ...(bias ? { lat: bias.lat, lng: bias.lng } : {}),
      });
      if (!found.found || found.lat == null || found.lng == null) {
        toast({
          title: "Couldn't place that address",
          description:
            found.message ?? "We couldn't find that address on the map.",
          variant: "destructive",
        });
        return;
      }
      onSearch({
        label: trimmed,
        address: null,
        lat: found.lat,
        lng: found.lng,
        origin: "search",
      });
    } catch (error: any) {
      toast({
        title: "Couldn't place that address",
        description: pinErrorMessage(error),
        variant: "destructive",
      });
    } finally {
      setLooking(false);
    }
  };

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm p-4">
      <div className="flex items-start justify-between gap-2 mb-1">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Navigation className="w-4 h-4 text-muted-foreground" />
          Who&apos;s closest
        </h3>
        {target && (
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear the selected address"
            className="text-muted-foreground hover:text-foreground shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <p className="text-xs text-muted-foreground mb-2">
        Tap any pin on the map, or type an address here, and your whole crew is
        listed nearest first.
      </p>

      <div className="flex gap-2 mb-3">
        <div className="flex-1 min-w-0">
          <AddressAutocomplete
            testId="input-closest-address"
            value={address}
            onChange={setAddress}
            onSelect={look}
            bias={bias}
            disabled={looking}
            placeholder="Type a client's address"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => look(address)}
          disabled={looking || !address.trim()}
          className="gap-2 shrink-0"
          data-testid="button-measure-address"
        >
          {looking ? (
            <RefreshCw className="w-4 h-4 animate-spin" />
          ) : (
            <Navigation className="w-4 h-4" />
          )}
          {looking ? "Finding…" : "Measure"}
        </Button>
      </div>

      {searchedTargets.length > 0 && (
        <div
          className="mb-3 rounded-lg border border-border/70 bg-background/40 p-2"
          data-testid="searched-destinations"
        >
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Searched pins
            </span>
            <button
              type="button"
              className="text-[11px] font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onClick={onClearSearches}
            >
              Clear all
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {searchedTargets.map((searched) => (
              <span
                key={searched.searchId}
                className="inline-flex max-w-full items-center overflow-hidden rounded-full border border-border bg-card"
              >
                <button
                  type="button"
                  onClick={() => onSelectSearch?.(searched)}
                  className="inline-flex min-w-0 items-center gap-1.5 py-1 pl-1.5 pr-1 text-xs hover:bg-accent"
                  title={searched.label}
                >
                  <span
                    className="inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white"
                    style={{ background: droppedPinColor(searched.ordinal) }}
                  >
                    S{searched.ordinal}
                  </span>
                  <span className="max-w-36 truncate">{searched.label}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Remove searched pin ${searched.ordinal}`}
                  onClick={() => onRemoveSearch?.(searched.searchId)}
                  className="p-1 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            New searches add pins; earlier searches stay visible until removed.
          </p>
        </div>
      )}

      {/* Anyone the ranking can't answer for, named. Silently leaving them out
          is how a cleaner ends up never being sent anywhere. */}
      {missingHomes.length > 0 && (
        <p
          className="text-[11px] text-amber-500 mb-3"
          data-testid="text-staff-without-home"
        >
          Not on the map: {missingHomeNames}. Add a home address on their Team
          card and they&apos;ll be ranked here too.
        </p>
      )}

      {target && (
        <>
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              From{" "}
              <span className="font-medium text-foreground">
                {target.label}
              </span>
              {target.address ? ` · ${target.address}` : ""}
            </p>
            {activeRouteId && onAddStop && (
              <Button
                size="sm"
                variant="secondary"
                className="h-7 text-[11px]"
                onClick={() => onAddStop(target)}
              >
                <Plus className="w-3 h-3 mr-1" /> Add stop
              </Button>
            )}
          </div>

          {ranked.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              None of your crew has a location yet. Add home addresses on the
              Team page and they&apos;ll be ranked here.
            </p>
          ) : (
            <ul className="space-y-2" data-testid="list-closest-crew">
              {ranked.map((c) => {
                const bookHref = canBook
                  ? target.bookingId != null
                    ? `/bookings/new?rebookId=${target.bookingId}&assign=${c.teamMemberId}`
                    : `/bookings/new?assign=${c.teamMemberId}`
                  : null;
                const row = (
                  <>
                    <span className="flex items-center gap-2 min-w-0">
                      {/* Their own colour, and the same two shapes the map uses:
                        a car for someone out working, a house for the address
                        on their card. Read the list and the map the same way. */}
                      <span
                        className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-white"
                        style={{
                          background: colorForTeamMember(
                            c.teamMemberId,
                            c.color,
                          ),
                          opacity: c.active ? 1 : 0.5,
                        }}
                        aria-hidden="true"
                      >
                        {c.source === "live" ? (
                          <Car className="w-3.5 h-3.5" />
                        ) : (
                          <Home className="w-3.5 h-3.5" />
                        )}
                      </span>
                      <span className="min-w-0">
                        <span
                          className={`block truncate ${c.active ? "text-foreground" : "text-muted-foreground"}`}
                          style={{
                            color: c.active
                              ? colorForTeamMember(c.teamMemberId, c.color)
                              : undefined,
                          }}
                        >
                          {c.name}
                          {c.active ? "" : " · off roster"}
                          {hiddenCleaners.has(c.teamMemberId) && (
                            <span
                              className="text-muted-foreground italic font-normal"
                              data-testid={`text-hidden-cleaner-${c.teamMemberId}`}
                            >
                              {" "}
                              · live hidden
                            </span>
                          )}
                        </span>
                        <span className="block text-xs text-muted-foreground truncate">
                          {c.source === "live"
                            ? `On the move · ${lastSeenLabel(c.updatedAt!)}`
                            : (c.address ?? "From their home address")}
                        </span>
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-sm font-semibold text-foreground">
                        {formatKm(c.km)}
                      </span>
                      <span className="block text-[11px] text-muted-foreground">
                        {formatDriveMinutes(c.km)} drive
                      </span>
                    </span>
                  </>
                );
                return (
                  <li
                    key={c.teamMemberId}
                    className="border-b border-border/60 pb-2 last:border-0 last:pb-0"
                  >
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onCompare(c, target)}
                        className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-md -mx-1.5 px-1.5 py-0.5 text-left text-sm hover:bg-accent/60 transition-colors"
                        aria-label={`Compare ${c.name} with ${target.label}`}
                        data-testid={`button-compare-cleaner-${c.teamMemberId}`}
                      >
                        {row}
                      </button>
                      {bookHref && (
                        <Link
                          href={bookHref}
                          className="shrink-0 rounded-md border border-brand-blue px-2 py-1 text-[11px] font-semibold text-brand-blue hover:bg-brand-blue/10"
                          aria-label={`Book ${c.name}`}
                          data-testid={`link-book-cleaner-${c.teamMemberId}`}
                        >
                          Book
                        </Link>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {ranked.length > 0 && (
            <p className="text-[11px] text-muted-foreground mt-2">
              Select a cleaner to compare.
              {canBook ? " Use Book to start a new booking." : ""}
            </p>
          )}

          <p className="text-[11px] text-muted-foreground mt-3">
            Distances are straight-line and drive times are rough city estimates
            — good for picking who to call first.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Three shapes, one meaning each — the legend says which is which, and the
 * swatches are drawn to match the markers rather than approximate them.
 */
function Legend({
  measuring,
  hasOffice,
}: {
  measuring: boolean;
  hasOffice: boolean;
}) {
  return (
    <div className="flex items-center gap-x-4 gap-y-1 flex-wrap min-w-0">
      <span className="flex items-center gap-1.5">
        <span className="w-3 h-3 rounded-full bg-brand-blue inline-block" />
        <Car className="w-3 h-3" /> Cleaners out now
      </span>
      {/* Only once an office exists — a legend entry for a marker that isn't
          on anyone's map yet would just be noise. */}
      {hasOffice && (
        <span className="flex items-center gap-1.5" data-testid="legend-office">
          <span
            className="w-3 h-3 rounded-[3px] inline-block"
            style={{ background: OFFICE_COLOR }}
          />
          <Building2 className="w-3 h-3" /> Office
        </span>
      )}
      <span className="flex items-center gap-1.5">
        <span className="w-3 h-3 rounded-full border-2 border-brand-blue inline-block" />
        <Home className="w-3 h-3" /> Staff homes
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-3 h-3 bg-brand-pink inline-block rounded-[50%_50%_50%_0] rotate-45" />
        Client properties
      </span>
      <span className="flex items-center gap-1.5">
        <span className="relative inline-block h-4 w-4" aria-hidden="true">
          <span className="absolute bottom-0 left-0.5 h-4 w-0.5 bg-brand-purple" />
          <span className="absolute left-1 top-0 h-2.5 w-3 rounded-sm bg-brand-purple [clip-path:polygon(0_0,100%_0,78%_50%,100%_100%,0_100%)]" />
        </span>
        Dispatcher waypoints
      </span>
      {/* Only while the tool is on: a legend entry for a scratch overlay that
          isn't there would just be one more thing to read on a busy row. */}
      {measuring && (
        <span className="flex items-center gap-1.5">
          <span
            className="w-3 h-3 rounded-full inline-block border-2 border-dashed border-white"
            style={{ background: MEASURE_COLOR }}
          />
          Measuring (not saved)
        </span>
      )}
    </div>
  );
}

/** Invalidate whichever span the map is currently showing. */
function useRefreshMap(mapParams: GetMapDataParams) {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      queryKey: getGetMapDataQueryKey(mapParams),
    });
}

function pinErrorMessage(error: any): string {
  return (
    error?.data?.error ||
    error?.message ||
    "We couldn't find that address on the map. Check it and try again."
  );
}

/**
 * The bar above the map: find an address and pin it, drop a pin by hand, and
 * measure between two spots.
 *
 * Picking a suggestion saves the pin straight away — the dispatcher has
 * already made the decision at that point, and a second click to confirm is
 * just friction. Typing an address by hand still works: the server geocodes
 * whatever text it's given, which is what keeps this usable on a key that has
 * no Places access.
 *
 * Everything except measuring is dispatch work and the API says so, hence the
 * `canEditPins` split — a cleaner is offered the measure tool alone rather
 * than controls that would 403. Measuring writes nothing anywhere.
 */
export function MapToolbar({
  bias,
  mapParams,
  canEditPins,
  dropMode,
  dropping,
  tools,
  measurement,
  drivingMeasurement,
  drivingMeasurementLoading,
  drivingMeasurementError,
  onToggleDropMode,
  onToggleMeasure,
  onClearMeasure,
}: {
  bias?: { lat: number; lng: number };
  mapParams: GetMapDataParams;
  canEditPins: boolean;
  dropMode: boolean;
  dropping: boolean;
  tools: MapToolState;
  measurement: ReturnType<typeof measurementOf>;
  drivingMeasurement?: {
    distanceMeters: number;
    durationSeconds: number;
  };
  drivingMeasurementLoading?: boolean;
  drivingMeasurementError?: boolean;
  onToggleDropMode: () => void;
  onToggleMeasure: () => void;
  onClearMeasure: () => void;
}) {
  const { toast } = useToast();
  const createPin = useCreateMapPin();
  const refresh = useRefreshMap(mapParams);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");

  const save = (rawAddress: string) => {
    const trimmed = rawAddress.trim();
    if (!trimmed || createPin.isPending) return;
    // No label typed? The address is the label — better than making someone
    // invent a name for "the house on the corner".
    const label = name.trim() || trimmed;
    createPin.mutate(
      { data: { name: label, address: trimmed } },
      {
        onSuccess: () => {
          refresh();
          toast({
            title: "Dropped on the map",
            description: `${label} is now a saved location.`,
          });
          setName("");
          setAddress("");
        },
        onError: (error: any) => {
          toast({
            title: "Couldn't drop that pin",
            description: pinErrorMessage(error),
            variant: "destructive",
          });
        },
      },
    );
  };

  // The measure toggle is the one control on this bar every role gets, so it
  // is built once and placed in whichever layout is being rendered.
  const measureButton = (
    <Button
      type="button"
      variant={tools.tool === "measure" ? "default" : "outline"}
      onClick={onToggleMeasure}
      className="gap-2"
      aria-pressed={tools.tool === "measure"}
      data-testid="button-measure-mode"
    >
      {tools.tool === "measure" ? (
        <X className="w-4 h-4" />
      ) : (
        <Ruler className="w-4 h-4" />
      )}
      {tools.tool === "measure" ? "Stop measuring" : "Measure"}
    </Button>
  );

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm p-3 space-y-2">
      {canEditPins ? (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto_auto_auto]">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (optional) — e.g. Smith residence"
            aria-label="Pin label"
          />
          <AddressAutocomplete
            value={address}
            onChange={setAddress}
            onSelect={save}
            bias={bias}
            placeholder="Search an address — it pins as soon as you pick one"
          />
          <Button
            onClick={() => save(address)}
            disabled={createPin.isPending || !address.trim()}
            className="gap-2"
          >
            {createPin.isPending ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Search className="w-4 h-4" />
            )}
            {createPin.isPending ? "Finding…" : "Find & pin"}
          </Button>
          {/* The escape hatch for places an address can't describe — a back
              lane, a gate, an acreage the mailing address misses by a field. */}
          <Button
            type="button"
            variant={dropMode ? "default" : "outline"}
            onClick={onToggleDropMode}
            disabled={dropping}
            className="gap-2"
            aria-pressed={dropMode}
            data-testid="button-drop-pin"
          >
            {dropping ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : dropMode ? (
              <X className="w-4 h-4" />
            ) : (
              <Crosshair className="w-4 h-4" />
            )}
            {dropping ? "Saving…" : dropMode ? "Cancel" : "Drop a pin"}
          </Button>
          {measureButton}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {measureButton}
          <p className="text-xs text-muted-foreground min-w-0">
            Pick two spots on the map to see how far apart they are.
          </p>
        </div>
      )}

      {dropMode && (
        <p className="text-xs text-brand-purple flex items-center gap-1.5">
          <Crosshair className="w-3.5 h-3.5 shrink-0" />
          Click anywhere on the map to save exact spots. Keep clicking to add
          more; press Esc when finished.
        </p>
      )}

      {tools.tool === "measure" && (
        <MeasureReadout
          tools={tools}
          measurement={measurement}
          drivingMeasurement={drivingMeasurement}
          loading={drivingMeasurementLoading}
          error={drivingMeasurementError}
          onClear={onClearMeasure}
        />
      )}
    </div>
  );
}

/**
 * What the measure tool is currently saying.
 *
 * The completed answer is always a Google driving route. While Google is
 * working, or if no route is available, that state is explicit and no
 * straight-line arithmetic is shown as a driving answer.
 */
function MeasureReadout({
  tools,
  measurement,
  drivingMeasurement,
  loading,
  error,
  onClear,
}: {
  tools: MapToolState;
  measurement: ReturnType<typeof measurementOf>;
  drivingMeasurement?: {
    distanceMeters: number;
    durationSeconds: number;
  };
  loading?: boolean;
  error?: boolean;
  onClear: () => void;
}) {
  const labels = drivingMeasurement
    ? formatDrivingMeasurement(
        drivingMeasurement.distanceMeters,
        drivingMeasurement.durationSeconds,
      )
    : null;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
      data-testid="text-measure-readout"
    >
      <span
        className="flex items-center gap-1.5 font-semibold shrink-0"
        style={{ color: MEASURE_COLOR }}
      >
        <Ruler className="w-3.5 h-3.5 shrink-0" />
        Measuring
      </span>

      {measurement && labels ? (
        <span className="min-w-0 text-muted-foreground">
          <span
            className="font-semibold"
            style={{ color: MEASURE_COLOR }}
            data-testid="text-measure-distance"
          >
            {labels.distance} driving
          </span>{" "}
          · {labels.duration} ·{" "}
          {measurePointLabel(measurement.start, "Point A")} →{" "}
          {measurePointLabel(measurement.end, "Point B")}
        </span>
      ) : measurement && loading ? (
        <span className="min-w-0 text-muted-foreground">
          Finding the actual driving route with Google…
        </span>
      ) : measurement && error ? (
        <span className="min-w-0 font-medium text-destructive">
          Driving route unavailable. Google could not route between these
          points.
        </span>
      ) : tools.start ? (
        <span className="min-w-0 text-muted-foreground">
          From{" "}
          <span className="font-medium text-foreground">
            {measurePointLabel(tools.start, "Point A")}
          </span>{" "}
          — now click the second spot.
        </span>
      ) : (
        <span className="min-w-0 text-muted-foreground">
          Click two spots — bare map, or anything already on it. Esc cancels.
        </span>
      )}

      <button
        type="button"
        onClick={onClear}
        className="ml-auto shrink-0 underline underline-offset-2 text-muted-foreground hover:text-foreground"
        data-testid="button-measure-clear"
      >
        Clear
      </button>
    </div>
  );
}

/**
 * The saved locations already on the map, with delete for dispatch.
 *
 * The checkbox on each row is the same idea as the roster strip's: untick to
 * take that pin off the map, tick to bring it back. Unlike delete it's
 * offered to every role — it changes what this user sees, not the pin.
 */
function SavedPins({
  pins,
  mapParams,
  canEdit,
  hiddenPins,
  onTogglePin,
  activeRouteId,
  onAddStop,
}: {
  pins: MapData["pins"];
  mapParams: GetMapDataParams;
  canEdit: boolean;
  hiddenPins: Set<number>;
  onTogglePin: (id: number) => void;
  activeRouteId?: number | null;
  onAddStop?: (pin: {
    name: string;
    address: string | null;
    lat: number;
    lng: number;
  }) => void;
}) {
  const { toast } = useToast();
  const deletePin = useDeleteMapPin();
  const refresh = useRefreshMap(mapParams);

  const handleDelete = (id: number, pinName: string) => {
    deletePin.mutate(
      { id },
      {
        onSuccess: () => {
          refresh();
          toast({ title: "Pin removed", description: `${pinName} removed.` });
        },
        onError: (error: any) => {
          toast({
            title: "Couldn't remove that pin",
            description: pinErrorMessage(error),
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm p-4">
      <h3 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-3">
        <Home className="w-4 h-4 text-muted-foreground" />
        Saved locations
      </h3>

      {pins.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {canEdit
            ? "No saved pins yet. Search an address at the top of the page to add one."
            : "No saved pins yet."}
        </p>
      ) : (
        <ul className="space-y-2">
          {pins.map((p) => {
            const shown = !hiddenPins.has(p.id);
            return (
              <li
                key={p.id}
                className="flex items-start justify-between gap-2 text-sm border-b border-border/60 pb-2 last:border-0 last:pb-0"
              >
                <label className="flex items-start gap-2 min-w-0 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={shown}
                    onChange={() => onTogglePin(p.id)}
                    aria-label={
                      shown
                        ? `Hide ${p.name} on the map`
                        : `Show ${p.name} on the map`
                    }
                    data-testid={`checkbox-pin-shown-${p.id}`}
                    className="mt-0.5 shrink-0 accent-brand-purple"
                  />
                  <span className="min-w-0">
                    <span
                      className={`block font-medium truncate ${
                        shown ? "text-foreground" : "text-muted-foreground"
                      }`}
                    >
                      {p.name}
                    </span>
                    {p.address && (
                      <span className="block text-xs text-muted-foreground truncate">
                        {p.address}
                      </span>
                    )}
                    {!shown && (
                      <span className="block text-[11px] text-brand-purple">
                        Hidden on the map — tick to show it again
                      </span>
                    )}
                  </span>
                </label>
                <div className="flex items-center gap-1 shrink-0">
                  {activeRouteId && onAddStop && (
                    <button
                      type="button"
                      onClick={() =>
                        onAddStop({
                          name: p.name,
                          lat: p.lat,
                          lng: p.lng,
                          address: p.address ?? null,
                        })
                      }
                      title={`Add ${p.name} to active route`}
                      className="text-muted-foreground hover:text-brand-purple p-1"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  )}
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => handleDelete(p.id, p.name)}
                      disabled={deletePin.isPending}
                      aria-label={`Delete ${p.name}`}
                      className="text-muted-foreground hover:text-red-400 p-1"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Rename a saved pin or give it a new address. A changed address is sent
 * without coordinates so the server re-geocodes it, exactly like creating
 * a pin; an unchanged address sends nothing, so the pin doesn't move.
 */
function EditPinDialog({
  pin,
  pending,
  onClose,
  onSave,
}: {
  pin: { id: number; name: string; address: string | null } | null;
  pending: boolean;
  onClose: () => void;
  onSave: (changes: { name?: string; address?: string }) => void;
}) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");

  // Re-seed the fields each time a different pin is opened.
  useEffect(() => {
    if (pin) {
      setName(pin.name);
      setAddress(pin.address ?? "");
    }
  }, [pin]);

  const handleSave = () => {
    if (!pin) return;
    const changes: { name?: string; address?: string } = {};
    const trimmedName = name.trim();
    const trimmedAddress = address.trim();
    if (trimmedName && trimmedName !== pin.name) changes.name = trimmedName;
    if (trimmedAddress && trimmedAddress !== (pin.address ?? "")) {
      changes.address = trimmedAddress;
    }
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    onSave(changes);
  };

  return (
    <Dialog open={pin !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit saved pin</DialogTitle>
          <DialogDescription>
            Rename this spot, or type a new address to move the pin there.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Pin name"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Address</label>
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Street address"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={pending || !name.trim()}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RouteAddDialog({
  maps,
  draft,
  pending,
  onClose,
  onSave,
}: {
  maps: GoogleMapsApi | null;
  draft: MeasurePoint | null;
  pending: boolean;
  onClose: () => void;
  onSave: (name: string, address: string) => void;
}) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");

  useEffect(() => {
    if (draft) {
      setName("");
      setAddress("");
      if (draft.lat && draft.lng && maps) {
        reverseGeocode(maps, draft.lat, draft.lng)
          .then((res) => {
            if (res) {
              setAddress(res);
              if (!name) setName(res.split(",")[0] || "");
            }
          })
          .catch(() => {});
      }
    }
  }, [draft, maps]);

  const handleSave = () => {
    if (!draft || !name.trim()) return;
    onSave(name.trim(), address.trim());
  };

  return (
    <Dialog open={draft !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add route stop</DialogTitle>
          <DialogDescription>
            Name this stop for your route. Address is optional.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">
              Name (Required)
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. 123 Main St, Supply pickup"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              Address (Optional)
            </label>
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Full street address"
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={pending || !name.trim()}>
            {pending ? "Adding…" : "Add to route"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
