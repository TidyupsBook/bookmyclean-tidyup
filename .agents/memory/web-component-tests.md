---
name: Web component tests setup
description: How .tsx component tests run in the booking web package (jsdom pin, JSX runtime, alias)
---

The booking web app's vitest config is standalone (it deliberately skips vite.config.ts, which demands PORT). Component (.tsx) tests need three things there:

- **jsdom must stay on v26.** jsdom@30 pulls undici@8, which calls `webidl.util.markAsUncloneable` — missing on Node 20, so every jsdom test file crashes before running.
- **`esbuild: { jsx: "automatic" }`** in vitest.config.ts — the React plugin normally supplies the automatic JSX runtime, but tests bypass it, so JSX otherwise fails with `React is not defined`.
- The `@` → `src` alias and the `src/**/*.test.{ts,tsx}` include live in vitest.config.ts; tsx files opt into jsdom with a `// @vitest-environment jsdom` pragma so plain .ts tests stay in node.

**Why:** took several failing runs to converge (undici crash, missing @testing-library/dom peer, JSX runtime).
**How to apply:** when adding component tests or bumping jsdom/testing-library in the web package, keep the pin and pragma pattern; @testing-library/react also needs @testing-library/dom installed explicitly under pnpm.
