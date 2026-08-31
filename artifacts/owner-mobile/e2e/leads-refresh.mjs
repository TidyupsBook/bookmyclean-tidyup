/**
 * Browser-level regression for the mobile Leads route.
 *
 * This check intentionally runs against the exact Expo development domain
 * rather than the shared preview proxy. The shared proxy can rewrite the
 * Expo hostname and serve a different bundle, which makes a route-refresh
 * check pass or fail for the wrong app.
 *
 * The signed-in demo user and company are the same fictional account used by
 * scripts/store-screenshots.mjs. The password is kept outside the repository
 * in /tmp/demo-creds.json.
 *
 * Run from the repository root:
 *   pnpm --filter @workspace/owner-mobile run test:e2e:leads-refresh
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../book-my-cleaning/package.json",
  ),
);
const { chromium } = require("playwright-core");

const EXPO_DOMAIN = process.env.REPLIT_EXPO_DEV_DOMAIN;
const CHROMIUM_PATH = process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const CREDS_PATH = process.env.DEMO_CREDS_FILE || "/tmp/demo-creds.json";
const artifactDir = path.dirname(fileURLToPath(new URL(".", import.meta.url)));

if (!EXPO_DOMAIN) {
  throw new Error(
    "REPLIT_EXPO_DEV_DOMAIN is not set — cannot run the mobile Leads browser check against the exact Expo host.",
  );
}

if (!CHROMIUM_PATH) {
  throw new Error(
    "REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE is not set — cannot run the mobile Leads browser check.",
  );
}

if (!existsSync(CREDS_PATH)) {
  throw new Error(
    `Demo credentials are missing at ${CREDS_PATH}. Restore the existing fictional demo credentials before running this check.`,
  );
}

const credentials = JSON.parse(readFileSync(CREDS_PATH, "utf8"));
if (
  typeof credentials.email !== "string" ||
  typeof credentials.password !== "string"
) {
  throw new Error(
    `Demo credentials at ${CREDS_PATH} must contain email and password strings.`,
  );
}

const configuredHost = EXPO_DOMAIN.includes("://")
  ? new URL(EXPO_DOMAIN)
  : new URL(`https://${EXPO_DOMAIN}`);
const expectedOrigin = configuredHost.origin;
const expectedHost = configuredHost.host;
const baseUrl = expectedOrigin;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function exactExpoHost(page, stage) {
  const actual = new URL(page.url());
  if (hostViolation) {
    throw new Error(
      `Expo host was rewritten while ${stage}: expected ${expectedOrigin}, but the browser visited ${hostViolation}.`,
    );
  }
  if (
    actual.protocol !== configuredHost.protocol ||
    actual.host !== expectedHost
  ) {
    throw new Error(
      `Expo host was rewritten while ${stage}: expected ${expectedOrigin}, but the browser is at ${actual.origin}. ` +
        "This check must use REPLIT_EXPO_DEV_DOMAIN directly, not the shared preview domain.",
    );
  }
}

async function waitForEither(page, selectors, timeout = 180_000) {
  const waits = selectors.map(({ selector, value }) =>
    page
      .locator(selector)
      .first()
      .waitFor({ state: "visible", timeout })
      .then(() => value)
      .catch(() => null),
  );
  return Promise.race(waits);
}

async function ensureSignedIn(page) {
  await page.goto(`${baseUrl}/leads`, { waitUntil: "domcontentloaded" });
  exactExpoHost(page, "initial navigation to /leads");

  const initial = await waitForEither(page, [
    { selector: '[data-testid="leads-filter-all"]', value: "signed-in" },
    { selector: '[data-testid="email-input"]', value: "sign-in" },
  ]);

  if (initial === "sign-in") {
    log("Signing in with the fictional demo Clerk user…");
    await page.fill('[data-testid="email-input"]', credentials.email);
    await page.fill('[data-testid="password-input"]', credentials.password);
    await page.click('[data-testid="sign-in-button"]');

    const afterPassword = await waitForEither(page, [
      { selector: '[data-testid="code-input"]', value: "verification" },
      { selector: '[data-testid="leads-filter-all"]', value: "signed-in" },
    ]);

    if (afterPassword === "verification") {
      await page.fill('[data-testid="code-input"]', "424242");
      await page.click('[data-testid="verify-button"]');
    } else if (afterPassword !== "signed-in") {
      throw new Error(
        "The demo Clerk sign-in did not reach the app or a verification-code step.",
      );
    }

    await page
      .locator('[data-testid="leads-filter-all"]')
      .waitFor({ state: "visible", timeout: 90_000 });
    exactExpoHost(page, "after sign-in");
  } else if (initial !== "signed-in") {
    throw new Error(
      "The Expo app never reached Leads or the sign-in form. Check the mobile workflow and browser console.",
    );
  }

  // Establish a real Dashboard → Leads history entry. This makes the later
  // back-button navigation exercise the same stack transition as the phone.
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  exactExpoHost(page, "navigation to Dashboard");
  await page.getByText("Today", { exact: true }).waitFor({
    state: "visible",
    timeout: 90_000,
  });
  await page.goto(`${baseUrl}/leads`, { waitUntil: "domcontentloaded" });
  exactExpoHost(page, "signed-in navigation to /leads");
  await page
    .locator('[data-testid="leads-filter-all"]')
    .waitFor({ state: "visible", timeout: 90_000 });

  // Reload after authentication so Clerk must restore the fictional demo
  // session from browser state on the exact Expo host.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .locator('[data-testid="leads-filter-all"]')
    .waitFor({ state: "visible", timeout: 90_000 });
  exactExpoHost(page, "restoring the Clerk session");
}

function isTrackedLeadRequest(request) {
  const pathname = new URL(request.url()).pathname;
  return pathname === "/api/leads" || pathname === "/api/leads/sync-status";
}

async function chipIsActive(page, testId) {
  return page.getByTestId(testId).evaluate((element) => {
    const background = getComputedStyle(element).backgroundColor;
    const border = getComputedStyle(element).borderColor;
    return background === "rgb(236, 72, 153)" && border === background;
  });
}

const browser = await chromium.launch({
  executablePath: CHROMIUM_PATH,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({
  viewport: { width: 400, height: 720 },
});
const page = await context.newPage();
const trackedRequests = [];
let hostViolation = null;

page.on("request", (request) => {
  if (isTrackedLeadRequest(request)) {
    trackedRequests.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      url: request.url(),
    });
  }
});

page.on("framenavigated", (frame) => {
  if (frame !== page.mainFrame()) return;
  const url = new URL(frame.url());
  if (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin !== expectedOrigin
  ) {
    hostViolation ??= url.origin;
  }
});

try {
  log(`Using exact Expo host ${expectedOrigin}`);
  await ensureSignedIn(page);

  await page.getByTestId("leads-filter-all").click();
  await page.getByTestId("leads-source-filter-sheet").click();
  await page.getByText("Nina Kowalski", { exact: true }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page.getByText("From Google Sheet", { exact: true }).first().waitFor({
    state: "visible",
    timeout: 30_000,
  });

  if (!(await chipIsActive(page, "leads-filter-all"))) {
    throw new Error(
      "The selected status filter did not become active on Leads.",
    );
  }
  if (!(await chipIsActive(page, "leads-source-filter-sheet"))) {
    throw new Error(
      "The selected source filter did not become active on Leads.",
    );
  }
  log("Selected status and source filters on Leads.");

  // The next Leads requests must happen after the route leaves and returns.
  // Register the waiters before clicking Dashboard so a fast refetch cannot be
  // missed.
  const leadsAfterReturn = page.waitForRequest(
    (request) =>
      request.method() === "GET" &&
      new URL(request.url()).pathname === "/api/leads",
    { timeout: 30_000 },
  );
  const syncStatusAfterReturn = page.waitForRequest(
    (request) =>
      request.method() === "GET" &&
      new URL(request.url()).pathname === "/api/leads/sync-status",
    { timeout: 30_000 },
  );

  await page.getByTestId("back-button").click();
  exactExpoHost(page, "back navigation from Leads to Dashboard");
  await page.waitForURL(
    (url) => url.origin === expectedOrigin && url.pathname === "/",
    { timeout: 30_000 },
  );
  await page.getByText("Today", { exact: true }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page.getByTestId("new-leads-banner").waitFor({
    state: "visible",
    timeout: 30_000,
  });

  await page.getByTestId("new-leads-banner").click();
  await page
    .locator('[data-testid="leads-filter-all"]')
    .waitFor({ state: "visible", timeout: 30_000 });
  exactExpoHost(page, "return navigation from Dashboard to Leads");
  await Promise.all([leadsAfterReturn, syncStatusAfterReturn]);

  if (!(await chipIsActive(page, "leads-filter-all"))) {
    throw new Error(
      "The status filter did not persist after navigating Leads → Dashboard → Leads.",
    );
  }
  if (!(await chipIsActive(page, "leads-source-filter-sheet"))) {
    throw new Error(
      "The source filter did not persist after navigating Leads → Dashboard → Leads.",
    );
  }
  await page.getByText("Nina Kowalski", { exact: true }).waitFor({
    state: "visible",
    timeout: 30_000,
  });

  const returnedPaths = trackedRequests
    .slice(-2)
    .map((request) => request.path)
    .join(", ");
  log(
    `Returned to Leads with persisted filters; observed ${trackedRequests.length} tracked API requests (${returnedPaths}).`,
  );
  log("Leads refresh browser check passed.");
} catch (error) {
  const body = await page
    .evaluate(() => document.body?.innerText ?? "")
    .catch(() => "(page unavailable)");
  log(`\nLeads refresh browser check failed:\n${error?.stack ?? error}`);
  log(`\nPage URL: ${page.url()}\nPage text:\n${body.slice(0, 1_200)}`);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
