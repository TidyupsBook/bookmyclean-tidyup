---
name: Expo Router route files can't platform-split
description: Why .web.tsx variants of route files under app/ break the web bundle, and where platform splits belong
---

Route files under `app/` must not have platform extensions. Expo Router's
`require.context` scans every file in `app/`, so `map.tsx` + `map.web.tsx`
both get bundled on web — a native-only import (e.g. `react-native-maps`)
in the base file then fails the whole web bundle with "Importing
native-only module … on web".

**Why:** the router registers routes by scanning the directory, so both
platform variants of a route file are always bundled — the split never
takes effect there.

**How to apply:** keep one route file per screen; put the platform fork in
`components/` (e.g. `TrailMap.tsx` + `TrailMap.web.tsx`) where Metro
resolves platform extensions normally, and import it from the route.
