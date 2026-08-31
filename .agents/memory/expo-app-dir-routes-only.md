---
name: Expo app/ dir is routes-only
description: Why test files (or any non-screen module) must never live under owner-mobile's app/ directory, and the Metro blockList that enforces it.
---

**Rule:** Nothing but screens/layouts may live under `artifacts/owner-mobile/app/`. Component tests go in `artifacts/owner-mobile/__tests__/` and import screens via `@/app/...`.

**Why:** Expo Router turns every file under `app/` into a route, so Metro bundles it into the production iOS/Android bundles. A vitest component test placed next to its screen (importing `vitest` and jsdom-only testing libraries) kills the publish build with `[Metro] iOS Bundling failed … HTTP 500`, while dev looks perfectly healthy — dev bundles lazily per requested route, and nothing ever requests the test "route". The deploy build log buries the real error near the end, after misleading web-build sourcemap warnings.

**How to apply:** `metro.config.js` appends test-file patterns (`.test.*`, `__tests__/`) to `resolver.blockList`, merged with Expo's defaults, as insurance — but still keep tests out of `app/`. After any merge that adds mobile tests, check where the test files landed before the next publish.
