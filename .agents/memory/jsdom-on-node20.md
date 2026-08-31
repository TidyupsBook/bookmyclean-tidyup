---
name: jsdom version ceiling on Node 20
description: jsdom 27+ crashes on this repl's Node; pin ^26 for DOM-level tests, and what it can actually verify.
---

Pin `jsdom` to `^26` in this project. Newer majors pull in undici 8, which needs
a newer Node than the repl runs, and fail at *import* time with
`TypeError: webidl.util.markAsUncloneable is not a function` — an error that
looks like a broken install rather than a version ceiling.

**How to apply:** the artifacts' vitest configs run in the plain node
environment, so a DOM test imports `jsdom` directly instead of switching the
whole suite to a DOM environment.

What jsdom 26 handles well enough to assert against real `index.html`:

- `runScripts: "dangerously"` executes inline scripts (external and module
  scripts are simply not fetched, which is what you want when testing the
  pre-hydration state).
- `pretendToBeVisual: true` gives you `requestAnimationFrame`, so timer-based
  regressions actually fire during the test.
- `getComputedStyle` applies the document's own stylesheets, including
  descendant selectors — so you can assert what a visitor would *see*
  (`display: block` vs `none`) rather than asserting on a class name that a
  refactor could rename on both sides.
