---
name: Expo Launch static config
description: Expo Launch App Store builds need settings in static app.json
---

Expo Launch's configure step cannot write to a dynamic `app.config.js` or
`app.config.ts`. Expo settings and local config-plugin entries must live in
static `app.json`; a JavaScript config file causes the publish to fail before
native prebuild starts.

**Why:** Expo Launch injects signing and project metadata by editing app.json.
It refuses to mutate dynamic config, so the failure happens before any iOS
code or credentials are built.

**How to apply:** Keep app.json as the only Expo config file. Put local
config-plugin paths directly in its `expo.plugins` array and let those plugins
read build-time environment variables themselves.