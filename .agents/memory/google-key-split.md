---
name: One Google key rarely covers maps, geocoding and places
description: Why address suggestions are asked for server-side, and how to work out which key can do what.
---

Google keys are enabled per API and restricted per caller, so a key that draws
the map happily can be denied for Places or Geocoding — and the failure looks
different in each direction: the browser gets a 403 with
`API_KEY_SERVICE_BLOCKED`, the legacy web service returns HTTP 200 with a
`REQUEST_DENIED` status inside the body.

**Why it matters:** autocomplete asked from the browser fails silently and
leaves the owner typing into a box that never suggests anything. Ask from the
server instead: it can pick whichever key actually has Places enabled, try the
new API, remember a "blocked" verdict for a few minutes, and fall back to the
legacy endpoint — while typing keeps working no matter what comes back.

**How to apply:** before wiring a newly supplied key anywhere, probe it
server-side against each API you intend to use and keep the proven key on the
feature that already works. A browser Maps JS key restricted by HTTP referrer is
denied for *every* server-side call, so "denied everywhere from the server" does
not prove it is broken in the browser — and equally does not prove it works, so
never swap a working map onto it blind.

- Aug 2026: Directions API confirmed working on GOOGLE_MAPS_API_KEY (server-side driving routes for map trails); MAP_API1 and PLACES_API1 remain REQUEST_DENIED for it. The directions service negative-caches a denied key for 10 min and the UI falls back to a dashed straight-line estimate, so a key change degrades gracefully.
