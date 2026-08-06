/**
 * Minimal ambient declarations for the runtime-loaded Google Maps SDK.
 *
 * We deliberately avoid the full @types/google.maps dependency: the map page
 * touches only a small surface, and Google exposes `window.google` at runtime.
 * `gm_authFailure` is the ONLY channel Google uses to report that a key isn't
 * authorized for the Maps JavaScript API, so it must be a known global.
 */
interface Window {
  google?: {
    maps?: any;
  };
  /**
   * Called by Google Maps when the API key is rejected (not enabled for Maps
   * JS, referrer restriction, billing off, etc.). The map otherwise just greys
   * out silently, so the page installs a handler to show an explanatory banner.
   */
  gm_authFailure?: () => void;
}
