---
name: Expo dev origin needs CORS allowlisting
description: Phone/browser clients of the dev Expo app call the API cross-origin from the expo subdomain; the API CORS allowlist must include REPLIT_EXPO_DEV_DOMAIN, and the cors package does NOT answer disallowed preflights.
---

The dev Expo app is served from its own subdomain (`$REPLIT_EXPO_DEV_DOMAIN`, e.g. `<id>.expo.riker.replit.dev`), while the API lives on the main dev domain. Any browser context on a phone (the web build saved to a home screen, Safari, Expo Go's web fallback) therefore makes **cross-origin** API calls and triggers preflights.

**The trap:** the `cors` npm package does not short-circuit OPTIONS for a *disallowed* origin — it calls `next()`, so the preflight falls through to Clerk auth and dies with **401 on OPTIONS**. From the phone this looks like "couldn't reach the server" even though the server is up and the private-URL wall is off. In the API log the signature is bursts of `OPTIONS /api/me → 401` in a 1s/2s/4s retry pattern (react-query retries / the user tapping "Try again").

**Fix:** `process.env.REPLIT_EXPO_DEV_DOMAIN` is included in the CORS `allowedOrigins` set in the API server's app setup. It is unset in production, so production access is not widened (prod serves app + API same-origin from the canonical domain, so no preflights there anyway).

**How to diagnose next time:** a phone that loads the app but can't fetch data has three distinct layers — (1) private dev URL wall (zero requests arrive), (2) CORS preflight 401 (OPTIONS bursts in the log), (3) real auth failure (GET with 401). Check the API request log to tell them apart.
