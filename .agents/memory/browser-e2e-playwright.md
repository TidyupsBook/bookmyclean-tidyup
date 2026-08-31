---
name: Browser e2e via preinstalled Chromium
description: How to run real-browser checks in this workspace (playwright-core + env-provided Chromium, cross-site iframe setup)
---

# Browser e2e via preinstalled Chromium

The workspace ships a Playwright Chromium at `$REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE` (matching playwright 1.55). Use `playwright-core` (no browser download) with `chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] })`.

**Why:** installing full `playwright` tries to download browsers and fails; the nix-provided binary just works.

**How to apply:**
- To simulate the preview pane / blocked third-party storage: host a harness page on `127.0.0.1` that iframes the app served on `localhost` — different hostnames make it cross-SITE. Different **ports** alone are same-site, so third-party cookie blocking (`--block-third-party-cookies --test-third-party-cookie-phaseout`) would not kick in.
- The booking site's browser-level blank-page check lives at `artifacts/book-my-cleaning/e2e/shell-smoke.mjs` (`pnpm --filter @workspace/book-my-cleaning run test:e2e`); it builds prod itself and covers dev server, prod build, and a 404ing bundle. Vite build/dev there require `PORT` and `BASE_PATH` env vars.

Live-call alert titles intentionally flash between an alert string and the
page title. Browser tests should use the known static title as the baseline
and wait on DOM state rather than sampling `document.title` once.

**Why:** A one-time title read can land on the temporary alert half of the
cycle, making an otherwise correct dismissal test wait for a value that can
never be restored.

**How to apply:** When testing `LiveCallAlert`, capture the app's static title
from its fixture contract and assert the exact restoration after the live call
state is cleared.
