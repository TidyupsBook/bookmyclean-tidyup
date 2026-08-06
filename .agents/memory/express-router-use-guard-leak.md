---
name: Router-level guards leak across routers
description: Why role guards must be per-route in this API, never router.use()
---

All API sub-routers are mounted at the same base path, so every request flows through every sub-router until a route matches. A router-level `router.use(roleGuard)` inside one sub-router therefore runs for OTHER routers' routes mounted after it.

**Why:** an owner-only router-level guard once silently 403'd dispatchers and cleaners on every route mounted after that router — the whole app broke for non-owners.

This applies to `requireAuth` as much as to role guards, and it recurs — new routers get written with `router.use(requireAuth)` because that reads as the tidy option. The tell is a 401 on a path that has no matching route at all: the guard from an earlier-mounted router ran before the 404 could happen.

Most older routers still do this, so the app currently depends on **mount order** — anything public must be registered ahead of the first router that guards at router level, or it inherits that guard and stops being public.

**How to apply:** attach role guards per route, never via `router.use()`. The authorization matrix test suite pins this: it walks the live router and fails on any route missing an expectation, so add new routes to its matrix. Also check role before body validation when a handler does in-handler role checks, or blocked roles see 400 instead of 403.
