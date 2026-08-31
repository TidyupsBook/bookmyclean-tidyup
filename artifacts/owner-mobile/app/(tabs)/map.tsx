import React, { useCallback, useEffect, useState } from "react";
import { Platform, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import {
  getGetMapDataQueryKey,
  getGetMapConfigQueryKey,
  getGetMapRoutesQueryKey,
  useGetCompany,
  useGetCurrentUser,
  useGetMapConfig,
  useGetMapData,
  useGetMapRoutes,
} from "@workspace/api-client-react";
import { isValidTimeZone } from "@/lib/format";
import { type MapJob, type MapRouteLeg } from "@/lib/routeTrails";
import { loadShowTrails, saveShowTrails } from "@/lib/trail-preference";
import {
  MapScreenFrame,
  TrailLegend,
  TrailsSwitch,
} from "@/components/MapScreenShared";
// Platform-resolved: the real map on iOS/Android, a note on web (Metro picks
// TrailMap.web.tsx there — react-native-maps has no web renderer).
import { TrailMap } from "@/components/TrailMap";
import { DeviceManager } from "@/components/DeviceManager";

/** Same cadence as the web dashboard's trail refresh. */
const REFRESH_MS = 30_000;

export default function MapScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  // The trails switch is the boss's own view control, so only an owner is
  // offered it. Positive check: while the role is still loading nothing is
  // shown, rather than flashing a control a cleaner can't have.
  const me = useGetCurrentUser();
  const isOwner = me.data?.role === "owner";
  const who = me.data?.email ?? "";
  const [showTrails, setShowTrails] = useState(true);
  // Re-read when sign-in resolves — the key is per person, and until it does
  // we're reading the anonymous slot.
  useEffect(() => {
    let live = true;
    void loadShowTrails(who).then((stored) => {
      if (live) setShowTrails(stored);
    });
    return () => {
      live = false;
    };
  }, [who]);

  const onToggleTrails = useCallback(
    (next: boolean) => {
      setShowTrails(next);
      void saveShowTrails(who, next);
    },
    [who],
  );

  // Tapping a job pin's callout jumps to that booking's details — same
  // destination the schedule tab uses, so status/crew/notes are one tap
  // from the map. The pins are already scoped server-side (a cleaner only
  // ever gets their own), so every id here is one this viewer may open.
  const openBooking = useCallback(
    (bookingId: number) => router.push(`/booking/${bookingId}`),
    [router],
  );

  // The company record carries the timezone every arrival time must be
  // rendered in. Never fall back to UTC/device time — wait for it instead.
  const company = useGetCompany();
  const rawTimezone = company.data?.timezone;
  // Strict: an unusable timezone is an error state, never a device fallback.
  const timezone =
    rawTimezone && isValidTimeZone(rawTimezone) ? rawTimezone : undefined;
  const timezoneError = company.isError || (company.isSuccess && !timezone);

  // The endpoint already scopes trails: a cleaner gets their own, dispatch
  // gets the crew's — no role logic needed here.
  const routesQuery = useGetMapRoutes({
    query: {
      queryKey: getGetMapRoutesQueryKey(),
      refetchInterval: REFRESH_MS,
    },
  });
  const routes: MapRouteLeg[] = routesQuery.data?.routes ?? [];

  // Today's job pins for context around the trails. No date param: the
  // server defaults to the company's current day in its own timezone, and it
  // already scopes what a cleaner may see to their own assignments.
  const mapDataQuery = useGetMapData(undefined, {
    query: {
      queryKey: getGetMapDataQueryKey(),
      refetchInterval: REFRESH_MS,
    },
  });
  const jobs: MapJob[] = mapDataQuery.data?.jobs ?? [];
  // Native iOS uses Apple Maps and needs no browser key. Safari (including an
  // iPhone or iPad browser) resolves TrailMap.web.tsx, which loads Google Maps
  // only after this authenticated config request returns its referrer-safe key.
  const isBrowserMap = Platform.OS === "web";
  const mapConfig = useGetMapConfig({
    query: {
      queryKey: getGetMapConfigQueryKey(),
      enabled: isBrowserMap,
    },
  });
  const mapConfigError =
    isBrowserMap &&
    (mapConfig.isError || (mapConfig.isSuccess && !mapConfig.data.configured));
  const retryMap = useCallback(() => {
    void company.refetch();
    void routesQuery.refetch();
    void mapDataQuery.refetch();
    if (isBrowserMap) void mapConfig.refetch();
  }, [company, routesQuery, mapDataQuery, mapConfig, isBrowserMap]);
  // Switched off, the map keeps its job pins and loses the lines — and the
  // legend of ETAs that goes with them. The unfiltered `routes` is still what
  // decides whether there is anything on the road at all, so hiding the lines
  // never turns into "nobody is working".
  const drawnRoutes = showTrails ? routes : [];

  // ETA copy contains "N min away" — recompute each refresh tick so the
  // labels age with the data rather than freezing at first render.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  const ready = Boolean(timezone);
  // "Nothing to show" now means no trails AND no job pins — a day with jobs
  // but nobody driving yet still has a map worth looking at.
  const empty =
    routesQuery.isSuccess &&
    routes.length === 0 &&
    mapDataQuery.isSuccess &&
    jobs.length === 0;

  return (
    <MapScreenFrame
      insetsTop={insets.top}
      loading={
        (!ready && !timezoneError) ||
        routesQuery.isLoading ||
        mapDataQuery.isLoading
      }
      error={
        routesQuery.isError ||
        mapDataQuery.isError ||
        timezoneError ||
        mapConfigError
      }
      errorText={
        timezoneError
          ? "We couldn't read the company's timezone, so booking times cannot be placed safely on the map."
          : routesQuery.isError
            ? "The cleaner routes couldn't load. Check your connection and try again."
            : mapDataQuery.isError
              ? "The map jobs and cleaner locations couldn't load. Check your connection and try again."
              : mapConfigError
                ? "The browser map isn't configured for this account. Ask an administrator to check the Maps key."
                : undefined
      }
      onRetry={retryMap}
      empty={empty}
    >
      {isOwner ? (
        <TrailsSwitch value={showTrails} onValueChange={onToggleTrails} />
      ) : null}
      {isOwner ? <DeviceManager /> : null}
      {timezone ? (
        <TrailMap
          routes={drawnRoutes}
          jobs={jobs}
          cleaners={mapDataQuery.data?.cleaners ?? []}
          // Frame the opening camera only once both halves of the picture —
          // trails and job pins — have answered, so neither is cut out of
          // the first view by arriving second.
          framingReady={routesQuery.isSuccess && mapDataQuery.isSuccess}
          timezone={timezone}
          nowMs={nowMs}
          cameraPersistenceKey={who || undefined}
          onJobPress={openBooking}
          apiKey={
            isBrowserMap && mapConfig.data?.configured
              ? mapConfig.data.apiKey
              : undefined
          }
        />
      ) : null}
      {mapDataQuery.data?.livePositions.allowed === false ? (
        <View style={{ paddingHorizontal: 16 }}>
          <Text style={{ color: "#a16207", fontSize: 13 }}>
            {mapDataQuery.data.livePositions.reason ??
              "Live crew locations are unavailable outside company hours."}
          </Text>
        </View>
      ) : null}
      {timezone && drawnRoutes.length > 0 ? (
        <TrailLegend routes={routes} timezone={timezone} nowMs={nowMs} />
      ) : null}
    </MapScreenFrame>
  );
}
