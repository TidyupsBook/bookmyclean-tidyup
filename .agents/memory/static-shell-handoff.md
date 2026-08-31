---
name: Static shell → React handoff
description: Why the booking site's pre-rendered marketing shell must be dismissed by the app, not by a timer, and how Clerk's gates turn a slow handshake into a blank page.
---

# The page must never be able to show nothing

The booking site ships a full static marketing shell in `index.html` so crawlers
and JS-disabled visitors get real content. Whatever hides that shell is the only
thing standing between the visitor and an empty document.

**Rule: the shell may only be dismissed on evidence that the app rendered
content — never on a timer, and never on "the bundle executed".**

**Why:** it used to be hidden a couple of animation frames after
`DOMContentLoaded`. Anything that stopped React from painting in that window —
a module-scope `throw`, a chunk that 404s, an auth handshake that hangs — left a
genuinely blank page, and only in environments where the race was lost (the
Replit preview iframe), so it looked like an infrastructure problem when nothing
was down.

**How to apply:**

- Signal readiness from a **layout effect** (DOM committed, not yet painted) and
  only after `#root` actually has child elements. Retry on every commit: a first
  commit can legitimately render `null` (e.g. a redirect), so a one-shot
  `useEffect(..., [])` hands off too early.
- Keep the failure path in the inline `<script>` in `index.html`. It has to work
  when the bundle never runs at all, so it cannot live in TypeScript; the TS side
  is a thin wrapper over the global it exposes.
- Treat only a failed `SCRIPT` as fatal. Blocked font stylesheets and images are
  cosmetic and must not raise a scary banner.
- Ignore errors that arrive after the handoff — once the app is up, rendering
  errors are the app's own job.

# Clerk's `<Show>` renders nothing while auth is loading

`<Show when="signed-in">` / `<Show when="signed-out">` both render `null` until
Clerk resolves — the `fallback` prop does **not** cover the loading window. A
tree gated only on `<Show>` therefore renders an empty page for the entire
handshake, and forever if the handshake is blocked (third-party storage in an
iframe, a dev instance on another domain).

**How to apply:** anything gated on auth needs the three-way
`ClerkLoading` / `ClerkFailed` / `ClerkLoaded` split — they are exhaustive
(degraded counts as loaded). Public routes (marketing home, customer quote
links) must render *outside* any `ClerkLoaded` gate so they never wait on auth
at all.
