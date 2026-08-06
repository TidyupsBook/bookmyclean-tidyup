---
name: Google Maps setup and loading
description: Which Google APIs a Maps key needs, how each half fails when unauthorized, and the loading=async namespace trap
---

## Loading the JS SDK: `loading=async` empties the namespace

Loading the Maps script with `loading=async` (the mode Google now pushes) switches the SDK into *dynamic library* mode. `window.google.maps` appears as soon as the script runs, so every "is it ready?" guard passes — but it carries only `importLibrary`. `Map`, `InfoWindow`, `LatLngBounds` and the marker classes are **not** on it, and constructing off the namespace throws `Map is not a constructor`.

The libraries live in different buckets, which is easy to get wrong: `LatLngBounds` is in **core**, `Map`/`InfoWindow` are in **maps**, `AdvancedMarkerElement` is in **marker**. A `libraries=` URL param is not the pairing for this mode — request them with `importLibrary` instead.

**Why:** the two ways of loading look interchangeable and the failure only appears at runtime, on a signed-in-only page, so no build check or test catches it.

**How to apply:** have the loader `await importLibrary(...)` and resolve with the constructors themselves, so callers never read `window.google`. That makes the ordering bug unrepresentable rather than merely fixed. Keep the loader's unit tests stubbing a namespace that has *only* `importLibrary` — that's the shape that actually ships.

## Key authorization

A single `GOOGLE_MAPS_API_KEY` powers two independent things, and enabling one does not enable the other:

- **Maps JavaScript API** — draws the dispatcher map in the browser.
- **Geocoding API** — turns a typed job address into coordinates, server-side, so pins can be placed.
- **Places API (New)** — address autocomplete suggestions while typing.

Places is a *third* switch, off by default even on a key that already draws the map and geocodes, and it fails as a plain HTTP 403 rather than through the two channels above. Verify it with a direct request to `places.googleapis.com` before assuming the client code is wrong — in the browser the failure is only a rejected promise.

**Autocomplete choices worth keeping:** use the Places *data* API and render our own dropdown, not Google's drop-in element — its shadow DOM fights a dark theme. Google only bills autocomplete as one session if a place-details request closes it, so a selection handler that merely copies the prediction text pays per keystroke; fetch the place on selection or drop the session token honestly. And suggestions must degrade to a plain text box, since the server geocodes free text regardless.

**Why:** a key copied from another project is usually restricted to whatever that project used. A Maps-only key looks valid, passes any "is the key set?" check, and still leaves every pin unplaceable. The two halves fail in completely different, easily-missed ways:

- Server (Geocoding): HTTP 200 with `status: "REQUEST_DENIED"` in the JSON body — **not** an HTTP error, so naive `res.ok` checks sail straight past it.
- Browser (Maps JS): no exception and no failed request. Google reports auth failure **only** by calling the global `window.gm_authFailure` callback. Without a handler registered, the map silently greys out and looks like a rendering bug.

**How to apply:** when wiring or debugging maps, verify the key against both APIs separately — a live geocode request for the server half, and a registered `gm_authFailure` handler surfacing a visible banner for the browser half. Treat `REQUEST_DENIED` as a configuration error distinct from a lookup miss, and let background geocoding pause quietly on it rather than retrying every cycle.

## Incomplete addresses fail silently, in the worst way

A street address with no city or region usually does **not** return `ZERO_RESULTS`. Google picks the best match anywhere on earth and returns it with full confidence — "23 Harbor View Drive" from an Alberta cleaning company resolved to rural Virginia. Only some bare street names come back empty.

**Why:** this means a sloppy customer address produces a pin in the wrong country rather than a visible error, and nothing in the logs flags it. It looks like a mapping bug long after the real cause (data entry) has scrolled away.

**How to apply:** append the company's city/region to an address before geocoding when the address doesn't already contain one, and treat a result far outside the company's service area as suspect rather than authoritative. For negative-path tests, inject a stub geocoder — you cannot rely on a fake address failing.
