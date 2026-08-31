/**
 * Browser-level guard: the 'From Google Sheet' badge on the Leads page must
 * survive future refactors that rename the source field, swap the badge
 * component, or restructure the lead card layout.
 *
 * Strategy
 * --------
 * The real Clerk SDK requires FAPI network calls and a real Clerk tenant —
 * far too much to wire up in a headless test.  Instead we start a dedicated
 * dev server using vite.config.test.ts, which aliases @clerk/react to a
 * minimal always-signed-in mock.  That eliminates all Clerk init complexity
 * without touching the production config.
 *
 * The backend API (/api/leads, /api/map/config, /api/leads/sync-status) is
 * mocked via page.route() so the page receives exactly one sheet-sourced lead.
 *
 * Run: pnpm --filter @workspace/book-my-cleaning run test:e2e:badge
 * Requires REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE (present in this workspace).
 */

import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const artifactDir = path.dirname(fileURLToPath(new URL(".", import.meta.url)));
const APP_HOST = "localhost";
const APP_PORT = 4630;

const failures = [];
const cleanups = [];

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function check(ok, label) {
  if (ok) {
    log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    log(`  ✗ ${label}`);
  }
}

// ---------------------------------------------------------------------------
// Mock API data
// ---------------------------------------------------------------------------

const LEAD_ID = 10;

const sheetLead = {
  id: LEAD_ID,
  name: "Alice Sheet",
  status: "new",
  source: "sheet",
  sourceTab: "Facebook",
  createdAt: new Date().toISOString(),
  createdTime: null,
  phoneDisplay: "780-555-0001",
  phoneE164: "+17805550001",
  email: null,
  service: "Regular cleaning",
  bedrooms: "3",
  bathrooms: "2",
  dateOfServiceRequested: null,
  heardAbout: null,
  message: null,
  streetAddress: null,
  city: "Edmonton",
  province: "AB",
  postCode: null,
  platform: "Facebook",
  campaignName: null,
  inboxUrl: null,
  jobberSynced: false,
  jobberPushError: null,
  jobberWebUri: null,
  convertedBookingId: null,
  lat: null,
  lng: null,
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http
        .get(url, (res) => {
          res.resume();
          res.statusCode && res.statusCode < 500
            ? resolve()
            : Date.now() > deadline
              ? reject(new Error(`${url} kept failing`))
              : setTimeout(attempt, 500);
        })
        .on("error", () => {
          Date.now() > deadline
            ? reject(new Error(`Timed out waiting for ${url}`))
            : setTimeout(attempt, 500);
        });
    };
    attempt();
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const executablePath = process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE;
if (!executablePath) {
  console.error(
    "REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE is not set — cannot run browser check.",
  );
  process.exit(1);
}

try {
  // 1. Start a dedicated dev server using the test Vite config.
  //    vite.config.test.ts aliases @clerk/react → e2e/clerk-mock.tsx so the
  //    auth layer is bypassed entirely — no CDN, no FAPI calls.
  log("Starting test dev server (Clerk mock config)…");
  const dev = spawn(
    "pnpm",
    [
      "exec",
      "vite",
      "--config",
      "e2e/vite.config.test.ts",
      "--host",
      "0.0.0.0",
      "--port",
      String(APP_PORT),
    ],
    {
      cwd: artifactDir,
      env: {
        ...process.env,
        PORT: String(APP_PORT),
        BASE_PATH: "/",
        NODE_ENV: "development",
      },
      stdio: "ignore",
    },
  );
  cleanups.push(() => dev.kill("SIGTERM"));
  await waitForHttp(`http://${APP_HOST}:${APP_PORT}/`);
  log("Test dev server ready.");

  // 2. Launch real Chromium.
  const browser = await chromium.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  cleanups.push(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();

  // 3. Mock the backend API.
  //
  // NOTE: Playwright evaluates routes LIFO (last registered = first matched).
  // One consolidated handler avoids ordering surprises.
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const { pathname } = url;

    // --- Leads ---
    if (pathname.endsWith("/leads/sync-status")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          lastSuccessAt: null,
          lastSyncAt: null,
          lastError: null,
        }),
      });
    }
    if (/\/api\/leads(\/|$)/.test(pathname) || pathname === "/api/leads") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([sheetLead]),
      });
    }

    // --- Map ---
    if (pathname.startsWith("/api/map")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ configured: false }),
      });
    }

    // --- Company — AppLayout reads setupStatus on every render ---
    if (pathname === "/api/company") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: 1,
          name: "E2E Test Co",
          timezone: "America/Edmonton",
          greeting: "Hi there!",
          collectFields: [],
          customQuestions: [],
          ringThroughNumber: null,
          notificationNumber: null,
          ringThroughNumberRejected: null,
          notificationNumberRejected: null,
          phoneNumber: "+17805550000",
          jobberConnected: false,
          jobberSkipped: true,
          jobberAccountName: null,
          jobberNeedsReauth: false,
          jobberRedirectUri: "http://localhost/api/company/jobber/callback",
          jobberEnvironment: "production",
          quoConnected: true,
          setupStatus: {
            accountCreated: true,
            jobberConnected: false,
            jobberSkipped: true,
            jobberResolved: true,
            quoConnected: true,
            phoneProvisioned: true,
            receptionistConfigured: true,
            teamInvited: false,
            isLive: true,
            completedSteps: 5,
            totalSteps: 6,
          },
          createdAt: new Date().toISOString(),
        }),
      });
    }

    // --- /api/me — sidebar reads role/name ---
    if (pathname === "/api/me") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          role: "owner",
          teamMemberId: null,
          name: "E2E Owner",
          email: "e2e@test.example",
          companyName: "E2E Test Co",
          canCreateCompany: false,
          canTakeLiveCalls: true,
        }),
      });
    }

    // --- /api/healthz ---
    if (pathname === "/api/healthz") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok" }),
      });
    }

    // --- Absorb every other /api/* call ---
    // Default to an empty array — it's safe for .map / .reduce callers and
    // also acceptable for object-shaped responses that aren't accessed deeply.
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  // 4. Navigate to the Leads page and wait for the badge.
  log("\nNavigating to /leads …");
  await page.goto(`http://${APP_HOST}:${APP_PORT}/leads`, {
    waitUntil: "domcontentloaded",
  });

  const badgeSelector = `[data-testid="badge-sheet-${LEAD_ID}"]`;
  let badgeVisible = false;
  try {
    await page.waitForSelector(badgeSelector, { timeout: 30_000 });
    badgeVisible = true;
  } catch {
    const body = await page
      .evaluate(() => document.body?.innerText ?? "")
      .catch(() => "(unreachable)");
    log(`  Page text at failure:\n${body.slice(0, 800)}`);
  }

  check(
    badgeVisible,
    `'From Google Sheet' badge (${badgeSelector}) is visible in the DOM`,
  );

  if (badgeVisible) {
    const text = await page
      .locator(badgeSelector)
      .innerText()
      .catch(() => "");
    check(
      text.trim() === "From Google Sheet",
      `badge text reads "From Google Sheet" (got "${text.trim()}")`,
    );
  }
} catch (err) {
  failures.push(`unexpected error: ${err?.stack ?? err}`);
} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch {
      // best effort
    }
  }
}

if (failures.length) {
  log(`\nFAILED (${failures.length}):`);
  for (const f of failures) log(`  - ${f}`);
  process.exit(1);
}
log("\nAll badge visibility checks passed.");
process.exit(0);
