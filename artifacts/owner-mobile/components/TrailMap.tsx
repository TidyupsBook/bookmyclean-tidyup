/**
 * Native side of the Map tab: the real map with each live cleaner's coloured
 * trail to their next job, a destination dot, and the ETA chip riding the
 * middle of the line — the same drawing rules as the web dashboard's map.
 * The web build resolves TrailMap.web.tsx instead (react-native-maps has no
 * web renderer); this file must only ever be bundled for iOS/Android.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  AppState,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import MapView, {
  Marker,
  Polyline,
  PROVIDER_GOOGLE,
  type Camera,
} from "react-native-maps";
import {
  chipLabel,
  colorForTeamMember,
  headingLabel,
  isValidMapCoordinate,
  isValidMapPoint,
  jobPinDescription,
  midpointOf,
  regionForTrails,
  type MapJob,
  type MapRouteLeg,
} from "@/lib/routeTrails";

const persistedCameras = new Map<string, Camera>();

export function TrailMap({
  routes,
  jobs,
  cleaners,
  framingReady,
  timezone,
  nowMs,
  onJobPress,
  cameraPersistenceKey,
}: {
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
  /**
   * True only once BOTH the trails and the job-pin requests have answered.
   * Framing on the first dataset alone would lock the camera before the
   * slower request lands, cutting whichever of the two arrived second out
   * of the opening view.
   */
  framingReady: boolean;
  timezone: string;
  nowMs: number;
  /**
   * Tapping a job pin's callout (the name + time bubble) hands the booking
   * id back so the screen can open that booking's details. The server
   * already scoped which pins this viewer may see, so every id here is one
   * they're allowed to open.
   */
  onJobPress?: (bookingId: number) => void;
  /**
   * The Map tab can unmount this component when the owner visits another tab.
   * Keying the camera by the signed-in user lets a fresh TrailMap restore the
   * last place without sharing one user's viewport with another user.
   */
  cameraPersistenceKey?: string;
  /**
   * Used only by TrailMap.web.tsx. The native iOS/Android map uses Apple/Google
   * native providers and never needs a browser JavaScript key.
   */
  apiKey?: string;
}) {
  // Frame every trail — and the day's job pins — once the full first picture
  // is in AND the native map is ready; after that the person holding the phone
  // owns the camera. Android can ignore animateToRegion calls made before
  // onMapReady, leaving the camera at the continent-level fallback.
  const mapRef = useRef<MapView | null>(null);
  const framedRef = useRef(false);
  const cameraRef = useRef<Camera | null>(
    cameraPersistenceKey
      ? (persistedCameras.get(cameraPersistenceKey) ?? null)
      : null,
  );
  const appStateRef = useRef(AppState.currentState);
  const mapReadyRef = useRef(false);
  const previousCameraPersistenceKeyRef = useRef(cameraPersistenceKey);
  const [mapReady, setMapReady] = useState(false);
  const [cameraVersion, setCameraVersion] = useState(0);
  const [mapFailed, setMapFailed] = useState(false);
  const [mapAttempt, setMapAttempt] = useState(0);
  const handleMapReady = useCallback(() => {
    const wasReady = mapReadyRef.current;
    mapReadyRef.current = true;
    setMapReady(true);
    setMapFailed(false);
    // mapReady may still describe the previous native instance after a
    // background suspension. This callback is the readiness proof for the
    // current instance, so restore only after it has actually mounted.
    if (
      wasReady &&
      appStateRef.current === "active" &&
      cameraRef.current &&
      mapRef.current
    ) {
      mapRef.current.setCamera(cameraRef.current);
    }
  }, []);
  useEffect(() => {
    if (mapReady) return;
    const timeout = setTimeout(() => setMapFailed(true), 15_000);
    return () => clearTimeout(timeout);
  }, [mapReady, mapAttempt]);
  const retryMap = useCallback(() => {
    framedRef.current = false;
    mapReadyRef.current = false;
    setMapReady(false);
    setMapFailed(false);
    setMapAttempt((attempt) => attempt + 1);
  }, []);
  const restoreCamera = useCallback(() => {
    if (!mapReady || !mapRef.current || !cameraRef.current) return;
    mapRef.current.setCamera(cameraRef.current);
  }, [mapReady]);
  useEffect(() => {
    const previousKey = previousCameraPersistenceKeyRef.current;
    if (previousKey === cameraPersistenceKey) return;
    previousCameraPersistenceKeyRef.current = cameraPersistenceKey;

    if (!previousKey && cameraPersistenceKey) {
      // The current map belongs to the user whose profile just resolved. Keep
      // its already-captured view, and make it available to the next tab
      // mount under their now-known identity.
      if (cameraRef.current) {
        persistedCameras.set(cameraPersistenceKey, cameraRef.current);
      }
      return;
    }

    // A signed-out or different-user transition must never inherit another
    // person's viewport. A returning user can restore only their own cache.
    cameraRef.current = cameraPersistenceKey
      ? (persistedCameras.get(cameraPersistenceKey) ?? null)
      : null;
    framedRef.current = Boolean(cameraRef.current);
    restoreCamera();
  }, [cameraPersistenceKey, restoreCamera]);
  const captureCamera = useCallback(() => {
    if (!framedRef.current || !mapRef.current?.getCamera) return;
    // Keep a snapshot after user gestures as well as on backgrounding. A
    // native map may be destroyed before the asynchronous AppState snapshot
    // resolves when the process is killed or the OS reclaims its view.
    void mapRef.current
      .getCamera()
      .then((camera) => {
        cameraRef.current = camera;
        if (cameraPersistenceKey) {
          persistedCameras.set(cameraPersistenceKey, camera);
        }
      })
      .catch(() => {
        // The map can disappear between the guard and getCamera().
      });
  }, [cameraPersistenceKey]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      const wasActive = appStateRef.current === "active";
      appStateRef.current = nextState;
      if (wasActive && nextState !== "active" && mapRef.current?.getCamera) {
        // Capture the actual native camera rather than the opening region:
        // this includes user pan, zoom, heading, and pitch.
        void mapRef.current
          .getCamera()
          .then((camera) => {
            cameraRef.current = camera;
            if (cameraPersistenceKey) {
              persistedCameras.set(cameraPersistenceKey, camera);
            }
            // Foregrounding and native map recreation can complete before
            // this asynchronous snapshot. Re-run the guarded restore once
            // the camera is available.
            setCameraVersion((version) => version + 1);
          })
          .catch(() => {
            // A native view can be torn down while the app backgrounds.
            // The next map-ready event can still restore the last snapshot.
          });
      }
      if (nextState === "active") restoreCamera();
    });
    return () => subscription.remove();
  }, [cameraPersistenceKey, restoreCamera]);
  useEffect(() => {
    // Also handles a native MapView being recreated while the app is away.
    if (appStateRef.current === "active") restoreCamera();
  }, [cameraVersion, restoreCamera]);
  const safeJobs = useMemo(
    () => jobs.filter((job) => isValidMapCoordinate(job.lat, job.lng)),
    [jobs],
  );
  const safeCleaners = useMemo(
    () =>
      (cleaners ?? []).filter((cleaner) =>
        isValidMapCoordinate(cleaner.lat, cleaner.lng),
      ),
    [cleaners],
  );
  const safeRoutes = useMemo(
    () =>
      routes
        .filter((route) => isValidMapCoordinate(route.destLat, route.destLng))
        .map((route) => ({
          ...route,
          path: route.path.filter(isValidMapPoint),
        })),
    [routes],
  );
  const region = useMemo(
    () =>
      regionForTrails(
        safeRoutes,
        safeJobs.map((j) => ({ lat: j.lat, lng: j.lng })),
      ),
    [safeJobs, safeRoutes],
  );
  useEffect(() => {
    if (
      framedRef.current ||
      !mapReady ||
      !framingReady ||
      !region ||
      !mapRef.current ||
      cameraRef.current
    )
      return;
    framedRef.current = true;
    mapRef.current.animateToRegion(region, 400);
  }, [framingReady, mapReady, region]);

  return (
    <View style={styles.wrap}>
      <MapView
        key={mapAttempt}
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        provider={Platform.OS === "android" ? PROVIDER_GOOGLE : undefined}
        onMapReady={handleMapReady}
        onMapLoaded={handleMapReady}
        onRegionChangeComplete={captureCamera}
        initialCamera={cameraRef.current ?? undefined}
        initialRegion={
          cameraRef.current
            ? undefined
            : (region ?? {
                // Continent-level neutral start until the first trails land.
                latitude: 45,
                longitude: -100,
                latitudeDelta: 60,
                longitudeDelta: 60,
              })
        }
      >
        {/* Today's located jobs, drawn before the trails so a route line and
          its destination dot always sit on top. The pin hangs above its
          coordinate (bottom anchor) while a trail's destination dot is
          centred on it, so the two mark the same house without covering
          each other. */}
        {safeJobs.map((j) => (
          <Marker
            key={`job-${j.bookingId}`}
            coordinate={{ latitude: j.lat, longitude: j.lng }}
            anchor={{ x: 0.5, y: 1 }}
            title={j.customerName}
            description={jobPinDescription(j, timezone)}
            onCalloutPress={
              onJobPress ? () => onJobPress(j.bookingId) : undefined
            }
          >
            <View style={styles.jobPin}>
              <View style={styles.jobPinHead} />
              <View style={styles.jobPinTail} />
            </View>
          </Marker>
        ))}
        {safeCleaners.map((cleaner, index) => (
          <Marker
            key={`device-${cleaner.deviceId ?? `${cleaner.teamMemberId}-${index}`}`}
            coordinate={{ latitude: cleaner.lat, longitude: cleaner.lng }}
            title={cleaner.name}
          >
            <View
              style={[
                styles.carDot,
                {
                  backgroundColor: cleaner.isOwner
                    ? "#facc15"
                    : (cleaner.color ?? "#9ca3af"),
                },
              ]}
            />
          </Marker>
        ))}
        {safeRoutes.map((r) => {
          const color = colorForTeamMember(r.teamMemberId, r.color);
          const path = r.path.map((p) => ({
            latitude: p.lat,
            longitude: p.lng,
          }));
          const start = path[0];
          const mid = midpointOf(r.path);
          const dashed = r.source === "estimate";
          return (
            <React.Fragment key={r.teamMemberId}>
              {/* A real driving route is a solid line; the straight-line
                estimate is dashed — the map's own way of saying "roughly".
                Same rule as the web dashboard. */}
              {path.length >= 2 ? (
                <Polyline
                  coordinates={path}
                  strokeColor={color}
                  strokeWidth={4}
                  lineDashPattern={dashed ? [12, 10] : undefined}
                />
              ) : null}
              {/* The cleaner at the start of their trail. */}
              {start ? (
                <Marker
                  coordinate={start}
                  anchor={{ x: 0.5, y: 0.5 }}
                  title={r.name}
                  description={headingLabel(r, timezone, nowMs)}
                >
                  <View style={[styles.carDot, { backgroundColor: color }]} />
                </Marker>
              ) : null}
              {/* A small dot where the trail ends. */}
              <Marker
                coordinate={{ latitude: r.destLat, longitude: r.destLng }}
                anchor={{ x: 0.5, y: 0.5 }}
                title={`${r.name} → ${r.customerName}`}
              >
                <View style={[styles.destDot, { backgroundColor: color }]} />
              </Marker>
              {/* The ETA chip rides the middle of the line. */}
              {mid ? (
                <Marker
                  coordinate={{ latitude: mid.lat, longitude: mid.lng }}
                  anchor={{ x: 0.5, y: 0.5 }}
                  tracksViewChanges={Platform.OS === "ios"}
                >
                  <View style={[styles.chip, { borderColor: color }]}>
                    <Text style={styles.chipText}>
                      {chipLabel(r, timezone, nowMs)}
                    </Text>
                  </View>
                </Marker>
              ) : null}
            </React.Fragment>
          );
        })}
      </MapView>
      {!mapReady && !mapFailed ? (
        <View style={styles.noteWrap}>
          <ActivityIndicator color="#ec4899" />
          <Text style={styles.note}>Starting the native map…</Text>
        </View>
      ) : null}
      {mapFailed ? (
        <View style={styles.noteWrap}>
          <Text style={styles.note}>
            We couldn&apos;t start the native map. Check the app&apos;s Maps
            configuration and your connection, then try again.
          </Text>
          <Pressable accessibilityRole="button" onPress={retryMap}>
            <Text style={styles.retry}>Try again</Text>
          </Pressable>
        </View>
      ) : null}
      {framingReady &&
      (jobs.length > 0 || (cleaners?.length ?? 0) > 0 || routes.length > 0) &&
      safeJobs.length === 0 &&
      safeCleaners.length === 0 &&
      safeRoutes.length === 0 ? (
        <View style={styles.invalidNote} pointerEvents="none">
          <Text style={styles.note}>
            The map data has no usable locations yet.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { ...StyleSheet.absoluteFillObject },
  noteWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 10,
    backgroundColor: "#0d0a0f",
  },
  invalidNote: {
    position: "absolute",
    top: 16,
    left: 16,
    right: 16,
    alignItems: "center",
  },
  note: { color: "#d1c4d0", fontSize: 13, textAlign: "center" },
  retry: { color: "#ec4899", fontWeight: "600", fontSize: 13 },
  jobPin: { alignItems: "center" },
  jobPinHead: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: "#0d9488",
    borderWidth: 2.5,
    borderColor: "#ffffff",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  jobPinTail: {
    width: 2.5,
    height: 7,
    backgroundColor: "#0d9488",
    marginTop: -1,
  },
  carDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 3,
    borderColor: "#ffffff",
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  destDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "#ffffff",
  },
  chip: {
    backgroundColor: "#ffffff",
    borderWidth: 1.5,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  chipText: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 11,
    color: "#111111",
  },
});
