/**
 * Browser map for the Map tab. Native builds resolve TrailMap.tsx and use
 * react-native-maps; Safari resolves this file and uses Maps JS instead.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import colors from "@/constants/colors";
import {
  isValidMapCoordinate,
  isValidMapPoint,
  type MapJob,
  type MapRouteLeg,
} from "@/lib/routeTrails";
import {
  installGoogleMapsAuthFailureHandler,
  loadGoogleMaps,
  type GoogleMapsApi,
} from "@/lib/googleMaps.web";

const c = colors.light;

const EDMONTON = { lat: 53.5461, lng: -113.4938 };

type BrowserCamera = {
  center: { lat: number; lng: number };
  zoom: number;
};

const persistedCameras = new Map<string, BrowserCamera>();

export function TrailMap(props: {
  routes: MapRouteLeg[];
  jobs: MapJob[];
  cleaners?: Array<{
    teamMemberId: number;
    name: string;
    color?: string | null;
    isOwner: boolean;
    lat: number;
    lng: number;
    deviceId: number | null;
  }>;
  framingReady: boolean;
  timezone: string;
  nowMs: number;
  onJobPress?: (bookingId: number) => void;
  apiKey?: string;
  cameraPersistenceKey?: string;
}) {
  const containerRef = useRef<any>(null);
  const mapRef = useRef<any>(null);
  const overlaysRef = useRef<any[]>([]);
  const mapListenerRef = useRef<{ remove?: () => void } | null>(null);
  const cameraRef = useRef<BrowserCamera | null>(
    props.cameraPersistenceKey
      ? (persistedCameras.get(props.cameraPersistenceKey) ?? null)
      : null,
  );
  const framedRef = useRef(Boolean(cameraRef.current));
  const cameraPersistenceKeyRef = useRef(props.cameraPersistenceKey);
  cameraPersistenceKeyRef.current = props.cameraPersistenceKey;
  const previousCameraPersistenceKeyRef = useRef(props.cameraPersistenceKey);
  const [maps, setMaps] = useState<GoogleMapsApi | null>(null);
  const [loadError, setLoadError] = useState(false);
  const safeJobs = useMemo(
    () => props.jobs.filter((job) => isValidMapCoordinate(job.lat, job.lng)),
    [props.jobs],
  );
  const safeCleaners = useMemo(
    () =>
      (props.cleaners ?? []).filter((cleaner) =>
        isValidMapCoordinate(cleaner.lat, cleaner.lng),
      ),
    [props.cleaners],
  );
  const safeRoutes = useMemo(
    () =>
      props.routes
        .filter((route) => isValidMapCoordinate(route.destLat, route.destLng))
        .map((route) => ({
          ...route,
          path: route.path.filter(isValidMapPoint),
        })),
    [props.routes],
  );

  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
    const removeAuthFailureHandler = installGoogleMapsAuthFailureHandler(() => {
      if (!cancelled) setLoadError(true);
    });
    loadGoogleMaps(props.apiKey ?? "")
      .then((api) => {
        if (!cancelled) setMaps(api);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
      removeAuthFailureHandler();
    };
  }, [props.apiKey]);

  useEffect(() => {
    if (!maps || !containerRef.current || mapRef.current) return;
    try {
      const map = new maps.Map(containerRef.current, {
        center: cameraRef.current?.center ?? EDMONTON,
        zoom: cameraRef.current?.zoom ?? 11,
        mapId: "DEMO_MAP_ID",
        clickableIcons: false,
      });
      mapRef.current = map;
      mapListenerRef.current = map.addListener?.("idle", () => {
        if (!framedRef.current || !mapRef.current) return;
        const center = mapRef.current.getCenter?.();
        const zoom = mapRef.current.getZoom?.();
        const lat =
          typeof center?.lat === "function" ? center.lat() : center?.lat;
        const lng =
          typeof center?.lng === "function" ? center.lng() : center?.lng;
        if (
          !Number.isFinite(lat) ||
          !Number.isFinite(lng) ||
          !Number.isFinite(zoom)
        ) {
          return;
        }
        const camera = {
          center: { lat, lng },
          zoom,
        };
        cameraRef.current = camera;
        const key = cameraPersistenceKeyRef.current;
        if (key) persistedCameras.set(key, camera);
      });
    } catch {
      setLoadError(true);
    }
  }, [maps]);

  useEffect(() => {
    const previousKey = previousCameraPersistenceKeyRef.current;
    if (previousKey === props.cameraPersistenceKey) return;
    previousCameraPersistenceKeyRef.current = props.cameraPersistenceKey;

    if (!previousKey && props.cameraPersistenceKey) {
      // The user query can resolve after the map has already opened. Associate
      // that existing view with the now-known user without moving the map.
      if (cameraRef.current) {
        persistedCameras.set(props.cameraPersistenceKey, cameraRef.current);
      }
      return;
    }

    // A signed-out or different-user transition must never inherit another
    // person's viewport. A returning user can restore only their own cache.
    cameraRef.current = props.cameraPersistenceKey
      ? (persistedCameras.get(props.cameraPersistenceKey) ?? null)
      : null;
    framedRef.current = Boolean(cameraRef.current);
    const map = mapRef.current;
    if (map && cameraRef.current) {
      map.setCenter?.(cameraRef.current.center);
      map.setZoom?.(cameraRef.current.zoom);
    }
  }, [props.cameraPersistenceKey]);

  useEffect(() => {
    if (!maps || !mapRef.current) return;
    for (const overlay of overlaysRef.current) {
      overlay.listener?.remove?.();
      if ("map" in overlay) overlay.map = null;
      overlay.setMap?.(null);
    }
    overlaysRef.current = [];

    const map = mapRef.current;
    const points: Array<{ lat: number; lng: number }> = [];
    for (const job of safeJobs) {
      const marker = new maps.AdvancedMarkerElement({
        map,
        position: { lat: job.lat, lng: job.lng },
        title: job.customerName,
      });
      marker.listener = props.onJobPress
        ? marker.addListener?.("gmp-click", () =>
            props.onJobPress?.(job.bookingId),
          )
        : null;
      overlaysRef.current.push(marker);
      points.push({ lat: job.lat, lng: job.lng });
    }
    for (const [index, cleaner] of safeCleaners.entries()) {
      const marker = new maps.AdvancedMarkerElement({
        map,
        position: { lat: cleaner.lat, lng: cleaner.lng },
        title: cleaner.name,
      });
      marker.id = `cleaner-${cleaner.teamMemberId}-${cleaner.deviceId ?? index}`;
      overlaysRef.current.push(marker);
      points.push({ lat: cleaner.lat, lng: cleaner.lng });
    }
    for (const route of safeRoutes) {
      const path = route.path.map((point) => ({
        lat: point.lat,
        lng: point.lng,
      }));
      const line = new maps.Polyline({
        map,
        path,
        strokeColor: route.color ?? "#0d9488",
        strokeOpacity: 0.9,
        strokeWeight: 4,
        ...(route.source === "estimate" ? { icons: [] } : {}),
      });
      overlaysRef.current.push(line);
      points.push(...path, { lat: route.destLat, lng: route.destLng });
    }
    if (!framedRef.current && props.framingReady && points.length > 0) {
      const bounds = new maps.LatLngBounds();
      for (const point of points) bounds.extend(point);
      map.fitBounds(bounds, 48);
      framedRef.current = true;
    }
  }, [
    maps,
    props.framingReady,
    props.onJobPress,
    safeCleaners,
    safeJobs,
    safeRoutes,
  ]);

  useEffect(
    () => () => {
      mapListenerRef.current?.remove?.();
      mapListenerRef.current = null;
      for (const overlay of overlaysRef.current) {
        overlay.listener?.remove?.();
        if ("map" in overlay) overlay.map = null;
        overlay.setMap?.(null);
      }
      overlaysRef.current = [];
    },
    [],
  );

  return (
    <View style={styles.wrap}>
      <View ref={containerRef} style={styles.map} />
      {!maps && !loadError ? (
        <View style={styles.noteWrap}>
          <ActivityIndicator color={c.brandPink} />
          <Text style={styles.note}>Loading the live map…</Text>
        </View>
      ) : null}
      {loadError ? (
        <View style={styles.noteWrap}>
          <Text style={styles.note}>
            We couldn&apos;t start the live map. Check your connection, then
            refresh this page.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, minHeight: 320 },
  map: { flex: 1 },
  noteWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 10,
    backgroundColor: c.background,
  },
  note: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 13,
    color: c.mutedForeground,
    lineHeight: 19,
    textAlign: "center",
  },
});
