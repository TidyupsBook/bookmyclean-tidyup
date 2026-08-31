export type OpenMapMarker = { current: string | null };

export function closeMapMarkerCard(
  infoWindow: { close: () => void } | null | undefined,
  openMarker: OpenMapMarker,
): void {
  if (openMarker.current === null) return;
  infoWindow?.close();
  openMarker.current = null;
}

/**
 * One InfoWindow owns the map. Clicking its current pin closes it; clicking a
 * different pin replaces it. The caller supplies a stable domain key rather
 * than relying on a Google marker object's lifetime across data refreshes.
 */
export function toggleMapMarkerCard({
  key,
  marker,
  content,
  map,
  infoWindow,
  openMarker,
}: {
  key: string;
  marker: unknown;
  content: string | HTMLElement;
  map: unknown;
  infoWindow: {
    setContent: (content: string | HTMLElement) => void;
    open: (options: { map: unknown; anchor: unknown }) => void;
    close: () => void;
  };
  openMarker: OpenMapMarker;
}): boolean {
  if (openMarker.current === key) {
    infoWindow.close();
    openMarker.current = null;
    return false;
  }
  infoWindow.setContent(content);
  infoWindow.open({ map, anchor: marker });
  openMarker.current = key;
  return true;
}
