import { useEffect, useMemo, useRef, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";
import { PageHeader, LoadingSpinner } from "@/components/ui/shared";
import {
  useGetMapConfig,
  useGetMapData,
  useListBookingsInRange,
  useCreateMapPin,
  useDeleteMapPin,
  useSyncJobberCalendar,
  useGetCompany,
  useGetCurrentUser,
  getGetMapDataQueryKey,
  getListBookingsInRangeQueryKey,
  MapData,
  GetMapDataParams,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { MonthCalendar, ColumnCalendar } from "@/components/MapCalendar";
import { JobberSyncButton } from "@/components/JobberSyncButton";
import { useToast } from "@/hooks/use-toast";
import { companyTimeZone, formatZoned, zoneLabel } from "@/lib/time";
import { todayInZone, shiftDay } from "@/lib/schedule";
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
  initials,
  isStale,
  lastSeenLabel,
  hasCoords,
  partitionJobsByCoords,
  assigneeNames,
  accuracyLabel,
} from "@/lib/mapMarkers";
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
  X,
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

  const [view, setView] = useState<CalendarView>("day");
  // "Where are my clients" rather than "where is the crew today". The calendar
  // below keeps following the selected dates either way — only the map lets go
  // of them, so switching back doesn't lose the dispatcher's place.
  const [showAllPins, setShowAllPins] = useState(false);
  const [selectedDate, setSelectedDate] = useState(today);
  const [monthAnchor, setMonthAnchor] = useState(
    () => `${today.slice(0, 7)}-01`,
  );

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
    setSelectedDate(date);
    setMonthAnchor(`${date.slice(0, 7)}-01`);
  };

  const stepDate = (delta: number) => {
    const step = view === "week" ? 7 : view === "3day" ? 3 : 1;
    jumpToDate(shiftDay(selectedDate, delta * step));
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
                        onClick={() => setView(tab.id)}
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
                  onSelectDate={setSelectedDate}
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
                  onSelectDate={setSelectedDate}
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
  rangeLabel: string;
  calendar: React.ReactNode;
}) {
  const { data: me } = useGetCurrentUser();
  // Crew may watch the map, but adding and removing saved pins is dispatch
  // work and the API rejects it — so don't offer them a control that fails.
  // Positive check on purpose: while the role is still loading we show nothing
  // rather than flashing controls a cleaner could click into a 403.
  const canEditPins = me?.role === "owner" || me?.role === "dispatcher";
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const infoWindowRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const [maps, setMaps] = useState<GoogleMapsApi | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [authFailed, setAuthFailed] = useState(false);
  // "Click the map to pin it" mode. Off by default — an always-live click
  // handler would turn every stray click while panning into a saved pin.
  const [dropMode, setDropMode] = useState(false);
  const [dropping, setDropping] = useState(false);

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
  }, [maps]);

  const dropPin = useCreateMapPin();
  const refreshMap = useRefreshMap(mapParams);
  const { toast } = useToast();

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
    // One pin per click of the button. Leaving the mode on would let the next
    // stray click save another spot.
    setDropMode(false);
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
            toast({
              title: "Pin dropped",
              description: address
                ? `${address} is now a saved location.`
                : "Saved at the spot you clicked.",
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
      if (e.key === "Escape") setDropMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dropMode]);

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

    const bounds = new maps.LatLngBounds();
    let any = false;

    const attach = (marker: any, html: string) => {
      marker.__listener = marker.addListener("gmp-click", () => {
        infoWindow.setContent(html);
        infoWindow.open({ map, anchor: marker });
      });
      markersRef.current.push(marker);
    };

    // Cleaners — coloured initials, faded when stale.
    for (const c of mapData?.cleaners ?? []) {
      if (!hasCoords(c)) continue;
      const stale = isStale(c.updatedAt);
      const el = document.createElement("div");
      el.style.cssText = `width:34px;height:34px;border-radius:9999px;display:flex;align-items:center;justify-content:center;font:700 12px/1 "Plus Jakarta Sans",sans-serif;color:#fff;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);background:${colorForTeamMember(
        c.teamMemberId,
      )};opacity:${stale ? "0.45" : "1"};`;
      el.textContent = initials(c.name);
      const marker = new maps.AdvancedMarkerElement({
        map,
        position: { lat: c.lat, lng: c.lng },
        content: el,
        title: c.name,
        zIndex: 3,
      });
      const acc = accuracyLabel(c);
      attach(
        marker,
        `<div style="font-family:sans-serif;color:#111;min-width:150px">
          <div style="font-weight:700">${escapeHtml(c.name)}</div>
          <div style="font-size:12px;color:#555">Cleaner${
            acc ? ` · ${acc}` : ""
          }</div>
          <div style="font-size:12px;color:${
            stale ? "#b45309" : "#16a34a"
          };margin-top:2px">
            ${stale ? `Last seen ${lastSeenLabel(c.updatedAt)}` : "Live now"}
          </div>
        </div>`,
      );
      bounds.extend({ lat: c.lat, lng: c.lng });
      any = true;
    }

    // Job pins — square pink glyph, distinct from round cleaner dots.
    for (const j of locatedJobs) {
      const el = document.createElement("div");
      el.style.cssText = `width:26px;height:26px;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#fff;background:hsl(330,81%,55%);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);`;
      el.innerHTML = briefcaseSvg();
      // A place we've been to more than once says so on the pin itself —
      // otherwise every address looks like a one-off and the map loses the
      // one thing it knows about a regular client.
      if ((j.visits ?? 1) > 1) {
        const badge = document.createElement("div");
        badge.style.cssText = `position:absolute;top:-6px;right:-8px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#fff;color:hsl(330,81%,45%);border:1px solid hsl(330,81%,55%);font:700 10px/14px sans-serif;text-align:center;`;
        badge.textContent = j.visits! > 99 ? "99+" : String(j.visits);
        el.style.position = "relative";
        el.appendChild(badge);
      }
      const marker = new maps.AdvancedMarkerElement({
        map,
        position: { lat: j.lat, lng: j.lng },
        content: el,
        title: j.customerName,
        zIndex: 2,
      });
      attach(
        marker,
        `<div style="font-family:sans-serif;color:#111;min-width:170px">
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
        </div>`,
      );
      bounds.extend({ lat: j.lat, lng: j.lng });
      any = true;
    }

    // Homeowner pins — teardrop-style purple house, distinct again.
    for (const p of mapData?.pins ?? []) {
      if (!hasCoords(p)) continue;
      const el = document.createElement("div");
      el.style.cssText = `width:26px;height:26px;border-radius:6px 6px 6px 0;transform:rotate(45deg);display:flex;align-items:center;justify-content:center;background:hsl(276,60%,55%);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);`;
      const inner = document.createElement("div");
      inner.style.cssText = "transform:rotate(-45deg);color:#fff;";
      inner.innerHTML = homeSvg();
      el.appendChild(inner);
      const marker = new maps.AdvancedMarkerElement({
        map,
        position: { lat: p.lat, lng: p.lng },
        content: el,
        title: p.name,
        zIndex: 1,
      });
      attach(
        marker,
        `<div style="font-family:sans-serif;color:#111;min-width:150px">
          <div style="font-weight:700">${escapeHtml(p.name)}</div>
          <div style="font-size:12px;color:#555">${escapeHtml(
            p.address || "Saved location",
          )}</div>
        </div>`,
      );
      bounds.extend({ lat: p.lat, lng: p.lng });
      any = true;
    }

    // Staff homes — a house outline in the crew member's own colour, so it
    // reads as the same person as their live dot without being mistaken for
    // one. Shown all the time: "who lives nearest this job" is a question
    // asked while planning tomorrow, when nobody is transmitting at all.
    for (const s of mapData?.staffHomes ?? []) {
      if (!hasCoords(s)) continue;
      const color = colorForTeamMember(s.teamMemberId);
      const el = document.createElement("div");
      el.style.cssText = `width:26px;height:26px;border-radius:9999px;display:flex;align-items:center;justify-content:center;color:${color};background:#fff;border:2px solid ${color};box-shadow:0 1px 4px rgba(0,0,0,.4);opacity:${
        s.active ? "1" : "0.5"
      };`;
      el.innerHTML = homeSvg();
      const marker = new maps.AdvancedMarkerElement({
        map,
        position: { lat: s.lat, lng: s.lng },
        content: el,
        title: `${s.name} (home)`,
        zIndex: 1,
      });
      attach(
        marker,
        `<div style="font-family:sans-serif;color:#111;min-width:150px">
          <div style="font-weight:700">${escapeHtml(s.name)}</div>
          <div style="font-size:12px;color:#555">${escapeHtml(
            s.roleLabel,
          )} · Home${s.active ? "" : " · Off roster"}</div>
          <div style="font-size:12px;color:#555;margin-top:2px">${escapeHtml(
            s.address || "Saved location",
          )}</div>
        </div>`,
      );
      bounds.extend({ lat: s.lat, lng: s.lng });
      any = true;
    }

    if (any && !bounds.isEmpty()) {
      map.fitBounds(bounds, 64);
      // fitBounds settles asynchronously, so the clamp has to wait for it.
      const listener = map.addListener("idle", () => {
        listener.remove();
        if (map.getZoom() > MAX_FIT_ZOOM) map.setZoom(MAX_FIT_ZOOM);
      });
    } else {
      // Nothing to show for this day — sit over the service area rather than
      // wherever the dispatcher last dragged the map to.
      map.setCenter(HOME_CENTER);
      map.setZoom(HOME_ZOOM);
    }
  }, [maps, mapData, locatedJobs, timeZone]);

  // Final cleanup on unmount — no markers, listeners or info window left behind.
  useEffect(() => {
    return () => {
      for (const marker of markersRef.current) {
        if (marker.__listener) marker.__listener.remove();
        marker.map = null;
      }
      markersRef.current = [];
      if (infoWindowRef.current) infoWindowRef.current.close();
    };
  }, []);

  return (
    <div className="space-y-4">
      {/* The address search sits at the very top: dispatch's first move is
          usually "where is this customer?", and that shouldn't need scrolling
          past the map to a sidebar. */}
      {canEditPins && (
        <AddressSearchBar
          apiKey={apiKey}
          bias={biasCenter}
          mapParams={mapParams}
          dropMode={dropMode}
          dropping={dropping}
          onToggleDropMode={() => setDropMode((on) => !on)}
        />
      )}

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

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <Legend />
        <span>
          {isFetching
            ? "Refreshing…"
            : lastUpdated
              ? `Last updated ${new Date(lastUpdated).toLocaleTimeString()}`
              : ""}
        </span>
      </div>

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
          <SavedPins
            pins={mapData?.pins ?? []}
            mapParams={mapParams}
            canEdit={canEditPins}
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

function Legend() {
  return (
    <div className="flex items-center gap-4 flex-wrap">
      <span className="flex items-center gap-1.5">
        <span className="w-3 h-3 rounded-full bg-brand-blue inline-block" />
        <Users className="w-3 h-3" /> Cleaners
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-3 h-3 rounded-sm bg-brand-pink inline-block" />
        <Briefcase className="w-3 h-3" /> Jobs
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-3 h-3 rounded-sm bg-brand-purple inline-block" />
        <Home className="w-3 h-3" /> Saved pins
      </span>
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
 * Look up a customer's address and drop it on the map.
 *
 * Picking a suggestion saves the pin straight away — the dispatcher has
 * already made the decision at that point, and a second click to confirm is
 * just friction. Typing an address by hand still works: the server geocodes
 * whatever text it's given, which is what keeps this usable on a key that has
 * no Places access.
 */
function AddressSearchBar({
  apiKey,
  bias,
  mapParams,
  dropMode,
  dropping,
  onToggleDropMode,
}: {
  apiKey: string;
  bias?: { lat: number; lng: number };
  mapParams: GetMapDataParams;
  dropMode: boolean;
  dropping: boolean;
  onToggleDropMode: () => void;
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

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm p-3 space-y-2">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto_auto]">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (optional) — e.g. Smith residence"
          aria-label="Pin label"
        />
        <AddressAutocomplete
          apiKey={apiKey}
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
      </div>

      {dropMode && (
        <p className="text-xs text-brand-purple flex items-center gap-1.5">
          <Crosshair className="w-3.5 h-3.5 shrink-0" />
          Click anywhere on the map to save that exact spot. Press Esc to stop.
        </p>
      )}
    </div>
  );
}

/** The saved locations already on the map, with delete for dispatch. */
function SavedPins({
  pins,
  mapParams,
  canEdit,
}: {
  pins: MapData["pins"];
  mapParams: GetMapDataParams;
  canEdit: boolean;
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
          {pins.map((p) => (
            <li
              key={p.id}
              className="flex items-start justify-between gap-2 text-sm border-b border-border/60 pb-2 last:border-0 last:pb-0"
            >
              <div className="min-w-0">
                <div className="font-medium text-foreground truncate">
                  {p.name}
                </div>
                {p.address && (
                  <div className="text-xs text-muted-foreground truncate">
                    {p.address}
                  </div>
                )}
              </div>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => handleDelete(p.id, p.name)}
                  disabled={deletePin.isPending}
                  aria-label={`Delete ${p.name}`}
                  className="text-muted-foreground hover:text-red-400 shrink-0"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function briefcaseSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="7" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>`;
}

function homeSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
}
