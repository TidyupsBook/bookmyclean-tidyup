---
name: Vite e2e route reload stalls
description: A mocked Vite browser harness can stall in its route-loading fallback after a full-page navigation.
---

In the Clerk-mocked Vite browser harness, a second `page.goto()` to a lazy dashboard route can leave the app on its Suspense loading screen without a browser console error, even though the route module is requested.

**Why:** This prevents later assertions from executing and can look like a feature regression when the problem is isolated to the test harness's full-page navigation behavior.

**How to apply:** When adding browser coverage to a multi-page mocked test, make the new path independently reachable from an initial page load and prove each page transition completes before depending on it. Investigate and fix the harness before treating a later assertion timeout as product behavior.