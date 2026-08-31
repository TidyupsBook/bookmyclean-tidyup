---
name: Expo dev preview path prefix
description: Why the mobile artifact's dev preview URL needs a prefix-stripping proxy in front of `expo start`
---

# Expo dev preview path prefix

The rule: in dev, the mobile artifact's `$PORT` must be owned by a thin proxy that strips the artifact's base-path prefix (e.g. `/owner-mobile`) before forwarding to the real Expo dev server on an internal port. Root-path requests must pass through unchanged, and WebSocket upgrades (Metro HMR) must be forwarded too.

**Why:** The main dev domain's shared proxy forwards requests with the artifact prefix *intact*, but the Expo dev server only answers manifest requests at `/`. A phone opening `https://<dev-domain>/owner-mobile/` in Expo Go (which sends an `expo-platform: ios|android` header) got an HTML 404 back and died with a JSON parse error. Meanwhile the dedicated Expo dev domain (`$REPLIT_EXPO_DEV_DOMAIN`) proxies to the same port at the *root* path — that's what the preview pane and QR flow use — so the proxy must serve both shapes.

**How to apply:** The dev script runs the proxy (which spawns `expo start --port <free internal port>` itself) instead of `expo start --port $PORT` directly. Key details:
- Pick the internal port dynamically (listen on 0); fixed offsets can collide with other artifacts' assigned ports.
- Don't open `$PORT` until the internal Expo port accepts connections, so the workflow port check still means "dev server ready".
- Manifest bundle URLs are generated from `EXPO_PACKAGER_PROXY_URL` (the Expo dev domain), so after the first manifest fetch the phone talks to the Expo domain at root — only the initial manifest request needs the prefix handling.
- Browser automation must preserve the exact `$REPLIT_EXPO_DEV_DOMAIN` hostname. A standard `*.riker.replit.dev` host, or a rewritten `*-expo.riker.replit.dev` host, can render a stale/different bundle and produce false UI failures; trust the preview-resolved `*.expo.riker.replit.dev` URL.
- The production static server (`server/serve.js`) already handles `BASE_PATH` itself; this is dev-only.
- Regression tests live next to the proxy and run against a stub upstream that mimics Expo's behavior (JSON with platform header at root, HTML otherwise, 404 elsewhere).
