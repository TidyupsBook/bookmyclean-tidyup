---
name: Unlayered CSS in index.html outranks every Tailwind utility
description: Why a bare reset in a static/pre-render shell silently breaks app-wide layout under Tailwind v4, and the rule for adding CSS to index.html
---

Any CSS rule added to `index.html` (or any stylesheet loaded outside Tailwind's
`@layer`) must be scoped to a selector that only matches the block it belongs
to. Never ship a bare `*`, `html`, `body`, or element-type rule there.

**Why:** Tailwind v4 keeps its utilities inside `@layer`. An *unlayered* rule
beats a layered one regardless of specificity, so a single
`*, *::before, *::after { margin: 0; padding: 0 }` in the head cancels every
`p-*`, `m-*`, `mx-auto` and `max-w-*` in the whole app. The symptom is not a
CSS error: pages render with overlapping sections, content flush to the left
edge, and identical geometry at every viewport width — it looks like a broken
responsive layout, not a stylesheet problem. This shipped once via an
SEO/crawler pre-render shell whose reset was copied in unscoped.

**How to apply:** When adding a static shell, crawler fallback, splash screen,
or third-party snippet to `index.html`, wrap it in an id and prefix every rule
(`#static-shell *`, `#static-shell a`). If the app suddenly ignores spacing and
width utilities everywhere at once, look in `index.html` before looking at any
component.
