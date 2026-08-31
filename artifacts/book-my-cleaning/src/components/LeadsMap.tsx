/**
 * The map view on the Leads page: one pin per geocoded lead, so a dispatcher
 * can see where inquiries are coming from and spot the ones near existing
 * routes. Clicking a pin opens its card info and selects the lead so the
 * full lead card (with Create booking / Dismiss) renders under the map.
 *
 * Pins come from lead.lat/lng, resolved server-side by the shared geocode
 * backfill from the raw sheet address — leads with no usable address simply
 * aren't on the map, and the caller shows how many are still off-map.
 */
import { useEffect, useRef, useState } from "react";
import type { Lead } from "@workspace/api-client-react";
import { LoadingSpinner } from "@/components/ui/shared";
import {
  loadGoogleMaps,
  DEMO_MAP_ID,
  type GoogleMapsApi,
} from "@/lib/googleMaps";
import { pinMarker, escapeHtml, directionsHtml } from "@/lib/mapMarkerDom";

const HOME_CENTER = { lat: 53.5461, lng: -113.4938 }; // Edmonton
const HOME_ZOOM = 11;
const MAX_FIT_ZOOM = 14;
const MIN_FIT_ZOOM = 10;

/** Same status colours as the badges: pink = new, green = converted, grey = dismissed. */
function pinColorFor(status: Lead["status"]): string {
  switch (status) {
    case "converted":
      return "hsl(142,71%,45%)";
    case "dismissed":
      return "hsl(220,9%,46%)";
    default:
      return "hsl(330,81%,55%)";
  }
}

export function LeadsMap({
  apiKey,
  leads,
  onSelectLead,
}: {
  apiKey: string;
  leads: Lead[];
  /** A pin was clicked — the page shows that lead's full card. */
  onSelectLead: (leadId: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const infoWindowRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const [maps, setMaps] = useState<GoogleMapsApi | null>(null);
  const [loadError, setLoadError] = useState(false);
  // Reframe when the set of pinned leads changes, not on every refetch.
  const lastFramedKeyRef = useRef<string | null>(null);

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

  useEffect(() => {
    if (!maps || !containerRef.current || mapRef.current) return;
    mapRef.current = new maps.Map(containerRef.current, {
      center: HOME_CENTER,
      zoom: HOME_ZOOM,
      mapId: DEMO_MAP_ID,
      disableDefaultUI: false,
      clickableIcons: false,
    });
    infoWindowRef.current = new maps.InfoWindow();
  }, [maps]);

  useEffect(() => {
    if (!maps || !mapRef.current) return;
    const map = mapRef.current;
    const infoWindow = infoWindowRef.current;

    for (const marker of markersRef.current) {
      if (marker.__listener) marker.__listener.remove();
      marker.map = null;
    }
    markersRef.current = [];

    const pinned = leads.filter(
      (l): l is Lead & { lat: number; lng: number } =>
        l.lat != null && l.lng != null,
    );

    for (const lead of pinned) {
      const el = pinMarker(pinColorFor(lead.status));
      const marker = new maps.AdvancedMarkerElement({
        map,
        position: { lat: lead.lat, lng: lead.lng },
        content: el,
        title: lead.name || "Lead",
        zIndex: lead.status === "new" ? 2 : 1,
      });
      const address = [lead.streetAddress, lead.city, lead.province]
        .filter(Boolean)
        .join(", ");
      const html = `<div style="font-family:sans-serif;color:#111;min-width:170px">
          <div style="font-weight:700">${escapeHtml(lead.name || "No name given")}</div>
          ${address ? `<div style="font-size:12px;color:#555">${escapeHtml(address)}</div>` : ""}
          ${lead.service ? `<div style="font-size:12px;color:#555;margin-top:2px">${escapeHtml(lead.service)}</div>` : ""}
          <div style="font-size:12px;color:#555;margin-top:2px">Status: ${escapeHtml(lead.status)}</div>
          ${directionsHtml(address || null, lead.lat, lead.lng)}
        </div>`;
      marker.__listener = marker.addListener("gmp-click", () => {
        infoWindow.setContent(html);
        infoWindow.open({ map, anchor: marker });
        onSelectLead(lead.id);
      });
      markersRef.current.push(marker);
    }

    const framedKey = pinned.map((l) => l.id).join(",");
    if (lastFramedKeyRef.current !== framedKey) {
      lastFramedKeyRef.current = framedKey;
      if (pinned.length > 0) {
        const bounds = new maps.LatLngBounds();
        for (const l of pinned) bounds.extend({ lat: l.lat, lng: l.lng });
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
  }, [maps, leads, onSelectLead]);

  // Full teardown on unmount.
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
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden relative h-[380px] md:h-[460px]">
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
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}
