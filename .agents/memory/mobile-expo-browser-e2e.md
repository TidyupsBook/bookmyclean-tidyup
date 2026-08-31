---
name: Mobile Expo browser host checks
description: Host and bundle constraints for real-browser checks against the Expo mobile development app
---

## Rule

Real-browser checks for the Expo mobile artifact must navigate to the exact `REPLIT_EXPO_DEV_DOMAIN` origin and assert that origin after every meaningful navigation. A request that starts on the Expo hostname but lands on the shared preview hostname is a test failure, not a harmless redirect.

**Why:** the shared preview and Expo development hosts can serve different bundles and routing behavior. A browser harness that follows a host rewrite can report a result for the wrong app, hiding or inventing mobile regressions.

**How to apply:** use the environment-provided Chromium binary, keep the viewport mobile-sized, and stop with the observed and expected origins when the host changes. Do not substitute a local or shared-preview URL for the Expo host.

Clerk may decorate a completed custom sign-in destination with the shared-preview origin. On Expo web, retain the decorated path, query, and hash while routing it on the browser's current origin.

**Why:** using Clerk's absolute decorated URL leaves the Expo bundle. This Clerk version's browser navigation cannot be overridden with provider router props; those props are ignored on web.

**How to apply:** normalize the destination inside each custom sign-in/SSO finalization callback, leave native custom schemes unchanged, and reload after sign-in to exercise real session restoration. Browser regressions should remember any transient main-frame host escape, not merely assert the final URL.