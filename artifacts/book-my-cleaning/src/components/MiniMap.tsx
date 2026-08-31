/**
 * The mini map on the Schedule & Map page.
 *
 * Same data, same marker language as the Live Map — cars for cleaners out
 * now, houses for staff homes, pink teardrops for the jobs in the calendar's
 * span, purple for saved pins — just without the pin-editing tooling. It
 * respects the roster strip's show/hide choices, pans to a booking the
 * calendar clicked, and draws a temporary crosshair for a searched address.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { MapData } from "@workspace/api-client-react";
import { LoadingSpinner } from "@/components/ui/shared";
import { formatZoned, zoneLabel } from "@/lib/time";
import {
  loadGoogleMaps,
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
  assigneeNames,
  crewChipsFor,
} from "@/lib/mapMarkers";
import { selectMapMarkers } from "@/lib/mapMarkerSelection";
import { closeMapMarkerCard, toggleMapMarkerCard } from "@/lib/mapInfoWindow";
import { nearestCleaners } from "@/lib/nearest";
import { closestCrewHtml } from "@/lib/closestCrewCard";
import { pointsToFrame } from "@/lib/mapFraming";
import type { Coords } from "@/lib/nearest";
import {
  carSvg,
  crewBadgeRow,
  crosshairSvg,
  directionsHtml,
  escapeHtml,
  homeSvg,
  officeMarker,
  pinMarker,
  shortName,
} from "@/lib/mapMarkerDom";

const HOME_CENTER = { lat: 53.5461, lng: -113.4938 }; // Edmonton
const HOME_ZOOM = 11;
const MAX_FIT_ZOOM = 14;
const MIN_FIT_ZOOM = 10;
const FOCUS_ZOOM = 16;

/** The temporary pin for an address typed into the search box. */
export type SearchTarget = { label: string; lat: number; lng: number };

/** A calendar click; object identity so the same booking can be re-clicked. */
export type BookingFocus = { bookingId: number };

export function MiniMap({
  apiKey,
  mapData,
  timeZone,
  hiddenCleaners,
  hiddenPins,
  bookingFocus,
  searchTarget,
  canBook = false,
  onAuthFailed,
}: {
  apiKey: string;
  mapData: MapData | undefined;
  timeZone: string;
  /** Cleaners unchecked on the roster strip — only their live cars stay off. */
  hiddenCleaners: Set<number>;
  /** Saved pins unchecked in the Live Map's Saved locations panel. */
  hiddenPins: Set<number>;
  /** Set when a booking on the calendar below was clicked. */
  bookingFocus: BookingFocus | null;
  /** The temporary pin for a searched address, if any. */
  searchTarget: SearchTarget | null;
  /** Whether to show the separate, explicit booking action in place cards. */
  canBook?: boolean;
  onAuthFailed?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const infoWindowRef = useRef<any>(null);
  const openMarkerRef = useRef<string | null>(null);
  const markersRef = useRef<any[]>([]);
  const searchMarkerRef = useRef<any>(null);
  // Job markers by booking id, so a calendar click can land on its card.
  const jobMarkersRef = useRef(
    new Map<number, { marker: any; html: string }>(),
  );
  const [maps, setMaps] = useState<GoogleMapsApi | null>(null);
  const [loadError, setLoadError] = useState(false);
  // Once the user starts steering (a focus or a search), stop re-framing on
  // every data refresh — the 30-second poll must not yank the view around.
  const steeredRef = useRef(false);

  useEffect(() => {
    const prev = window.gm_authFailure;
    window.gm_authFailure = () => {
      setLoadError(true);
      onAuthFailed?.();
    };
    return () => {
      window.gm_authFailure = prev;
    };
  }, [onAuthFailed]);

  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
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

  useEffect(() => {
    if (!maps || !containerRef.current || mapRef.current) return;
    try {
      mapRef.current = new maps.Map(containerRef.current, {
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
    } catch (error) {
      console.error("[MiniMap] Google Maps initialization failed", error);
      mapRef.current = null;
      setLoadError(true);
    }
  }, [maps]);

  const framedKey = useMemo(() => {
    // Reframe when the *span* of data changes (a new date range), not on
    // every refresh of the same span.
    const jobs = (mapData?.jobs ?? []).map((j) => j.bookingId).join(",");
    return jobs;
  }, [mapData]);
  const lastFramedKeyRef = useRef<string | null>(null);

  // Redraw markers whenever the data or the hide list changes.
  useEffect(() => {
    if (!maps || !mapRef.current) return;
    const map = mapRef.current;
    const infoWindow = infoWindowRef.current;
    closeMapMarkerCard(infoWindow, openMarkerRef);

    for (const marker of markersRef.current) {
      if (marker.__listener) marker.__listener.remove();
      marker.map = null;
    }
    markersRef.current = [];
    jobMarkersRef.current = new Map();

    // The shared "what gets drawn" decision: hidden cleaners lose their live
    // car, homes and jobs stay, and unchecked saved pins disappear. Pinned by
    // unit tests in
    // mapMarkerSelection.test.ts.
    const visible = selectMapMarkers(mapData, hiddenCleaners, hiddenPins);

    const framePoints: Coords[] = [];

    const attach = (key: string, marker: any, content: string) => {
      marker.__listener = marker.addListener("gmp-click", () => {
        toggleMapMarkerCard({
          key,
          marker,
          content,
          map,
          infoWindow,
          openMarker: openMarkerRef,
        });
      });
      markersRef.current.push(marker);
    };

    for (const c of visible.cleaners) {
      const stale = isStale(c.updatedAt);
      // Owner devices come back bright yellow with a dark ring; the rest keep
      // their roster colour. Same rule as the full map, from the same helper.
      const style = markerStyleFor(c);
      const carColor = style.fill;
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
        caption.style.cssText = `position:absolute;top:-14px;left:50%;transform:translateX(-50%);white-space:nowrap;max-width:100px;overflow:hidden;text-overflow:ellipsis;padding:0 5px;border-radius:7px;background:#fff;color:#111;border:1px solid ${style.outline};font:700 9px/14px "Plus Jakarta Sans",sans-serif;`;
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
      attach(
        `cleaner:${c.teamMemberId}:${c.deviceId ?? "person"}`,
        marker,
        `<div style="font-family:sans-serif;color:#111;min-width:150px">
          <div style="font-weight:700">${escapeHtml(c.name)}</div>
          ${
            deviceLabel
              ? `<div style="font-size:12px;color:#111;font-weight:600">${escapeHtml(
                  deviceLabel,
                )}</div>`
              : ""
          }
          <div style="font-size:12px;color:${
            stale ? "#b45309" : "#16a34a"
          };margin-top:2px">
            ${stale ? `Last seen ${lastSeenLabel(c.updatedAt)}` : "Live now"}
          </div>
          ${directionsHtml(null, c.lat, c.lng)}
        </div>`,
      );
      framePoints.push({ lat: c.lat, lng: c.lng });
    }

    for (const j of visible.jobs) {
      const el = pinMarker("hsl(330,81%,55%)");
      // Crew badges: one disc per assigned cleaner in their roster colour,
      // same as the Live Map. An unassigned job keeps a bare pink pin.
      const crew = crewChipsFor(j);
      const badges = crewBadgeRow(crew.chips, crew.extra);
      if (badges) el.appendChild(badges);
      const marker = new maps.AdvancedMarkerElement({
        map,
        position: { lat: j.lat, lng: j.lng },
        content: el,
        title: `${j.customerName} — ${assigneeNames(j)}`,
        zIndex: 2,
      });
      const jobHtml = `<div style="font-family:sans-serif;color:#111;min-width:170px">
          <div style="font-weight:700">${escapeHtml(j.customerName)}</div>
          <div style="font-size:12px;color:#555">${escapeHtml(
            j.customerAddress || "Address not provided",
          )}</div>
          <div style="font-size:12px;color:#555;margin-top:2px">${escapeHtml(
            formatZoned(j.scheduledFor, timeZone),
          )} ${escapeHtml(zoneLabel(timeZone, new Date(j.scheduledFor)))}</div>
          <div style="font-size:12px;color:#555;margin-top:2px">Crew: ${escapeHtml(
            assigneeNames(j),
          )}</div>
          ${closestCrewHtml(
            // Raw mapData on purpose — the hide list is a display preference,
            // not an availability filter; distances must reflect geography.
            // See nearest.ts for the full rationale.
            nearestCleaners({ lat: j.lat, lng: j.lng }, mapData ?? {}),
            hiddenCleaners,
            {
              bookHref: canBook
                ? (cleaner) =>
                    `/bookings/new?rebookId=${j.bookingId}&assign=${cleaner.teamMemberId}`
                : undefined,
            },
          )}
          ${directionsHtml(j.customerAddress, j.lat, j.lng)}
        </div>`;
      attach(`job:${j.bookingId}`, marker, jobHtml);
      jobMarkersRef.current.set(j.bookingId, { marker, html: jobHtml });
      framePoints.push({ lat: j.lat, lng: j.lng });
    }

    for (const p of visible.pins) {
      const el = pinMarker("hsl(276,60%,55%)");
      const marker = new maps.AdvancedMarkerElement({
        map,
        position: { lat: p.lat, lng: p.lng },
        content: el,
        title: p.name,
        zIndex: 1,
      });
      attach(
        `pin:${p.id}`,
        marker,
        `<div style="font-family:sans-serif;color:#111;min-width:170px">
          <div style="font-weight:700">${escapeHtml(p.name)}</div>
          <div style="font-size:12px;color:#555">${escapeHtml(
            p.address || "Saved location",
          )}</div>
          ${closestCrewHtml(
            // Raw mapData on purpose — the hide list is a display preference,
            // not an availability filter; distances must reflect geography.
            // See nearest.ts for the full rationale.
            nearestCleaners({ lat: p.lat, lng: p.lng }, mapData ?? {}),
            hiddenCleaners,
            {
              bookHref: canBook
                ? (cleaner) => `/bookings/new?assign=${cleaner.teamMemberId}`
                : undefined,
            },
          )}
          ${directionsHtml(p.address, p.lat, p.lng)}
        </div>`,
      );
      framePoints.push({ lat: p.lat, lng: p.lng });
    }

    // The office — the same building marker the Live Map draws, parked on the
    // stored company spot, never on a reported browser fix.
    const office = mapData?.office;
    if (office) {
      const marker = new maps.AdvancedMarkerElement({
        map,
        position: { lat: office.lat, lng: office.lng },
        content: officeMarker(office.label),
        title: office.label,
        zIndex: 2,
      });
      attach(
        "office",
        marker,
        `<div style="font-family:sans-serif;color:#111;min-width:150px">
          <div style="font-weight:700">${escapeHtml(office.label)}</div>
          <div style="font-size:12px;color:#555">Office · always here</div>
          <div style="font-size:12px;color:#555;margin-top:2px">${escapeHtml(
            office.address || "Saved location",
          )}</div>
          ${directionsHtml(office.address, office.lat, office.lng)}
        </div>`,
      );
      framePoints.push({ lat: office.lat, lng: office.lng });
    }

    for (const s of visible.staffHomes) {
      const color = colorForTeamMember(s.teamMemberId, s.color);
      const el = document.createElement("div");
      el.style.cssText = `display:flex;flex-direction:column;align-items:center;gap:2px;opacity:${
        s.active ? "1" : "0.5"
      };`;
      const tag = document.createElement("div");
      tag.style.cssText = `padding:0 6px;border-radius:9px;background:#fff;color:${color};border:1px solid ${color};font:700 10px/16px "Plus Jakarta Sans",sans-serif;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.35);`;
      tag.textContent = shortName(s.name);
      // Same bold finish as the Live Map: solid colour, white glyph, so the
      // crew's homes read as strongly as the job pins beside them.
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
      attach(
        `home:${s.teamMemberId}`,
        marker,
        `<div style="font-family:sans-serif;color:#111;min-width:150px">
          <div style="font-weight:700">${escapeHtml(s.name)}</div>
          <div style="font-size:12px;color:#555">${escapeHtml(
            s.roleLabel,
          )} · Home${s.active ? "" : " · Off roster"}</div>
          ${directionsHtml(s.address, s.lat, s.lng)}
        </div>`,
      );
      framePoints.push({ lat: s.lat, lng: s.lng });
    }

    // Frame the new span once; after that (or once the user has clicked a
    // booking / searched an address) leave the viewport alone.
    const spanChanged = lastFramedKeyRef.current !== framedKey;
    if (spanChanged) {
      lastFramedKeyRef.current = framedKey;
      steeredRef.current = false;
    }
    if (!steeredRef.current && spanChanged) {
      if (framePoints.length > 0) {
        const bounds = new maps.LatLngBounds();
        for (const point of pointsToFrame(framePoints)) bounds.extend(point);
        map.fitBounds(bounds, 48);
        const listener = map.addListener("idle", () => {
          listener.remove();
          const zoom = map.getZoom();
          if (zoom > MAX_FIT_ZOOM) map.setZoom(MAX_FIT_ZOOM);
          else if (zoom < MIN_FIT_ZOOM) map.setZoom(MIN_FIT_ZOOM);
        });
      } else {
        map.setCenter(HOME_CENTER);
        map.setZoom(HOME_ZOOM);
      }
    }
  }, [maps, mapData, timeZone, hiddenCleaners, hiddenPins, framedKey, canBook]);

  // A booking clicked on the calendar: sit on its pin with the card open.
  useEffect(() => {
    if (!maps || !mapRef.current || !bookingFocus) return;
    const entry = jobMarkersRef.current.get(bookingFocus.bookingId);
    if (!entry) return;
    const map = mapRef.current;
    steeredRef.current = true;
    map.setCenter(entry.marker.position);
    map.setZoom(FOCUS_ZOOM);
    infoWindowRef.current?.setContent(entry.html);
    infoWindowRef.current?.open({ map, anchor: entry.marker });
    openMarkerRef.current = `job:${bookingFocus.bookingId}`;
    // Identity-triggered on purpose; the registry refills before this runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingFocus]);

  // The temporary crosshair for a searched address.
  useEffect(() => {
    if (!maps || !mapRef.current) return;
    const map = mapRef.current;
    if (searchMarkerRef.current) {
      if (openMarkerRef.current?.startsWith("search:")) {
        closeMapMarkerCard(infoWindowRef.current, openMarkerRef);
      }
      searchMarkerRef.current.__listener?.remove();
      searchMarkerRef.current.map = null;
      searchMarkerRef.current = null;
    }
    if (!searchTarget) return;
    const el = document.createElement("div");
    el.style.cssText = `width:26px;height:26px;border-radius:9999px;display:flex;align-items:center;justify-content:center;color:#fff;background:hsl(199,89%,48%);border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.5);`;
    el.innerHTML = crosshairSvg();
    searchMarkerRef.current = new maps.AdvancedMarkerElement({
      map,
      position: { lat: searchTarget.lat, lng: searchTarget.lng },
      content: el,
      title: searchTarget.label,
      zIndex: 4,
    });
    searchMarkerRef.current.__listener = searchMarkerRef.current.addListener(
      "gmp-click",
      () => {
        if (!infoWindowRef.current || !searchMarkerRef.current) return;
        toggleMapMarkerCard({
          key: `search:${searchTarget.lat}:${searchTarget.lng}`,
          marker: searchMarkerRef.current,
          content: `<div style="font-family:sans-serif;color:#111;min-width:160px">
            <div style="font-weight:700">${escapeHtml(searchTarget.label)}</div>
            <div style="font-size:12px;color:#555">Searched location</div>
            ${directionsHtml(null, searchTarget.lat, searchTarget.lng)}
          </div>`,
          map,
          infoWindow: infoWindowRef.current,
          openMarker: openMarkerRef,
        });
      },
    );
    steeredRef.current = true;
    map.panTo({ lat: searchTarget.lat, lng: searchTarget.lng });
  }, [maps, searchTarget]);

  // Full teardown on unmount.
  useEffect(() => {
    return () => {
      for (const marker of markersRef.current) {
        if (marker.__listener) marker.__listener.remove();
        marker.map = null;
      }
      markersRef.current = [];
      if (searchMarkerRef.current) {
        searchMarkerRef.current.__listener?.remove();
        searchMarkerRef.current.map = null;
        searchMarkerRef.current = null;
      }
      if (infoWindowRef.current) infoWindowRef.current.close();
    };
  }, []);

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden relative h-[320px] md:h-[380px]">
      {loadError && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground max-w-sm">
            We couldn&apos;t start Google Maps. The calendar is still available;
            check the Maps setup or connection, then refresh.
          </p>
        </div>
      )}
      {!maps && !loadError && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-card">
          <LoadingSpinner />
        </div>
      )}
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}
