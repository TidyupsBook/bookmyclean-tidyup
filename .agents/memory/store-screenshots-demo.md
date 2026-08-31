---
name: Store screenshots demo rig
description: How App Store / Play screenshots are produced — demo Clerk user, re-runnable seeder, Playwright capture — and the auth lesson it surfaced.
---

## Rule
Mobile bearer-token wiring must be registered synchronously in the ROOT layout (above all routes), never in the tabs layout.
**Why:** deep-linked stack screens (cold start, web hard reload) mount without the tabs layout; when the getter lived there, every request fired unauthenticated and 401'd forever — retries included. Cleanup must also be ownership-aware (only clear its own registration) or Strict Mode replay / remounts strand the app tokenless.
**How to apply:** any new token/interceptor wiring goes beside the existing root bridge component; tests pin registered-before-children, latest-getToken, StrictMode replay, and replacement-unmount ordering.

## Demo rig (re-runnable)
- Demo Clerk user `demo+clerk_test@tidyups.ca` ("Alex Morgan"); instance test_mode is ON, so verification code **424242** always works. Password lives ONLY in `/tmp/demo-creds.json` — never committed; recreate the user if the tmp file is gone.
- Seeder (api-server scripts) rebuilds the fictional "Sparkle Ridge Cleaning" company with fresh relative timestamps; fail-closed (deployment refusal + name/email fingerprint check before wipe, single transaction). Re-run right before capture so "today" bookings and live presence (5-min rule) are fresh.
- Capture script (owner-mobile scripts) drives Expo web via Playwright at exact store sizes: Apple 1290×2796, Google 1080×1920 (Play rejects >2:1, so Apple size can't be reused). Reuses `/tmp/demo-state.json` session — Clerk dev instances rate-limit repeated sign-ins.
- Map tab is excluded on purpose: web renders a "draws on your phone" text fallback, not the real map.

## Gotcha
After editing mobile code, restart the Expo workflow before browser-driving it — the dev server can keep serving a stale bundle, making a real fix look like it didn't work.
