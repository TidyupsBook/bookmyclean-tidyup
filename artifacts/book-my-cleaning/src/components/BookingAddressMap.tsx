/**
 * The booking desk's address check.
 *
 * The dispatcher is on the phone and the caller is reciting a street they say
 * every day and nobody else has ever heard. Reading it back is one thing;
 * seeing the pin land in the right neighbourhood is what actually catches
 * "Mullen Place" typed as "Mullen Plaza", or a suburb that turns out to be
 * ninety minutes away.
 *
 * So this looks the address up as it is typed — quietly, one lookup per
 * settled address — and shows it. It never writes back into the form: what the
 * customer said stays what the form holds, and the map is only ever an opinion
 * about it.
 */
import { useEffect, useRef, useState } from "react";
import { MapPin, Loader2, AlertTriangle } from "lucide-react";
import { geocodeMapAddress } from "@workspace/api-client-react";
import {
  loadGoogleMaps,
  DEMO_MAP_ID,
  type GoogleMapsApi,
} from "@/lib/googleMaps";
import { composeBookingAddress } from "@/lib/bookingAddress";

/**
 * How long the typing has to stop before the address is looked up.
 *
 * Every distinct string is a paid lookup at Google and the server caps them
 * per minute, so this is deliberately slower than a search box: the dispatcher
 * is writing down one address, not exploring.
 */
const LOOKUP_DEBOUNCE_MS = 900;

/** Close enough to see the house and its cross streets. */
const PIN_ZOOM = 16;

/** Where an empty map sits until an address places it (Edmonton). */
const HOME_CENTER = { lat: 53.5461, lng: -113.4938 };
const HOME_ZOOM = 10;

type Placed = { address: string; lat: number; lng: number };

export function BookingAddressMap({
  apiKey,
  street,
  addressLine2,
  city,
  province,
  postal,
}: {
  /** Empty when this deployment has no Maps key — the panel stays hidden. */
  apiKey: string;
  street: string;
  addressLine2: string;
  city: string;
  province: string;
  postal: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const [maps, setMaps] = useState<GoogleMapsApi | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [looking, setLooking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const address = composeBookingAddress({
    street,
    addressLine2,
    city,
    province,
    postal,
  });

  // Load the SDK once the panel is on screen. Shared promise, so this costs
  // nothing on a page that already drew a map.
  useEffect(() => {
    if (!apiKey) return;
    let cancelled = false;
    loadGoogleMaps(apiKey)
      .then((api) => {
        if (!cancelled) setMaps(api);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
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
      disableDefaultUI: true,
      zoomControl: true,
      clickableIcons: false,
    });
  }, [maps]);

  /**
   * Look the typed address up once the typing settles.
   *
   * The guard that matters is the response race: an address typed in three
   * bursts can have two lookups in flight, and the slower one must not win.
   * Each run owns a token, and a stale run drops its answer on the floor.
   */
  useEffect(() => {
    if (!apiKey) return;
    if (!address) {
      setPlaced(null);
      setProblem(null);
      setLooking(false);
      return;
    }
    // Already showing this exact address — nothing to pay Google for.
    if (placed?.address === address) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      setLooking(true);
      setProblem(null);
      geocodeMapAddress({ address })
        .then((found) => {
          if (cancelled) return;
          if (!found.found || found.lat == null || found.lng == null) {
            setPlaced(null);
            setProblem(
              found.message ?? "We couldn't find that address on the map.",
            );
            return;
          }
          setPlaced({ address, lat: found.lat, lng: found.lng });
          setProblem(null);
        })
        .catch((error: any) => {
          if (cancelled) return;
          setPlaced(null);
          setProblem(
            error?.data?.error ||
              "Address lookup isn't answering right now — the booking saves either way.",
          );
        })
        .finally(() => {
          if (!cancelled) setLooking(false);
        });
    }, LOOKUP_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [address, apiKey, placed]);

  // Move the pin to whatever was last placed.
  useEffect(() => {
    if (!maps || !mapRef.current) return;
    const map = mapRef.current;
    if (!placed) {
      if (markerRef.current) {
        markerRef.current.map = null;
        markerRef.current = null;
      }
      map.setCenter(HOME_CENTER);
      map.setZoom(HOME_ZOOM);
      return;
    }
    const position = { lat: placed.lat, lng: placed.lng };
    if (!markerRef.current) {
      const el = document.createElement("div");
      el.style.cssText =
        "width:22px;height:22px;border-radius:9999px;background:hsl(330,81%,55%);border:3px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.45)";
      markerRef.current = new maps.AdvancedMarkerElement({
        map,
        position,
        content: el,
        title: placed.address,
      });
    } else {
      markerRef.current.position = position;
      markerRef.current.map = map;
    }
    map.setCenter(position);
    map.setZoom(PIN_ZOOM);
  }, [maps, placed]);

  // No key on this deployment: the rest of the desk works, so say nothing.
  if (!apiKey) return null;

  return (
    <section
      className="bg-card border border-border rounded-xl shadow-sm overflow-hidden min-w-0"
      data-testid="booking-address-map"
    >
      <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <MapPin className="w-4 h-4 text-brand-pink shrink-0" />
          <h3 className="font-semibold text-foreground">Address check</h3>
          <span className="text-sm text-muted-foreground truncate">
            {placed
              ? placed.address
              : address
                ? address
                : "Type the address and it lands here."}
          </span>
        </div>
        {looking && (
          <span
            className="flex items-center gap-1.5 text-sm text-muted-foreground"
            data-testid="address-map-looking"
          >
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Placing it…
          </span>
        )}
      </div>

      {problem && (
        <p
          className="flex items-start gap-2 px-4 py-2 text-sm text-amber-600 dark:text-amber-400"
          data-testid="address-map-problem"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          {problem}
        </p>
      )}

      {loadFailed ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          The map didn't load. Everything else on this page still works.
        </p>
      ) : (
        <div ref={containerRef} className="h-[240px] w-full bg-secondary/40" />
      )}
    </section>
  );
}
