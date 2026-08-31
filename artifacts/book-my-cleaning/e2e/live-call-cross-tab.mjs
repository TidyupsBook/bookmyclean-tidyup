/**
 * Browser-level regression for cross-tab live-call dismissal.
 *
 * Two dashboard pages share the same browser storage. The first page also has
 * a different active call, which proves that dismissing one call only marks
 * that call seen rather than silencing the whole call watcher.
 *
 * Run with:
 *   pnpm --filter @workspace/book-my-cleaning run test:e2e:live-call-cross-tab
 */

import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const artifactDir = path.dirname(fileURLToPath(new URL(".", import.meta.url)));
const APP_HOST = "localhost";
const APP_PORT = 4645;
const failures = [];
const cleanups = [];

const TARGET_CALL_ID = 5481;
const OTHER_CALL_ID = 5482;
const OWNER_EMAIL = "owner@example.test";
const COMPANY_NAME = "Cross-tab Fixture Co";
const OTHER_OWNER_EMAIL = "other-owner@example.test";
const OTHER_COMPANY_NAME = "Other Owner Fixture Co";
const BASE_TITLE =
  "Tidyups | Edmonton's #1 Residential & Commercial Cleaning Service";

function log(message) {
  process.stdout.write(`${message}\n`);
}

function check(ok, label) {
  if (ok) log(`  ✓ ${label}`);
  else {
    failures.push(label);
    log(`  ✗ ${label}`);
  }
}

function call(id, callerName, status = "in_progress") {
  return {
    id,
    callerName,
    callerPhone: "780-555-5481",
    status,
    serviceRequested: "Standard cleaning",
    preferredTime: null,
    startedAt: "2026-08-27T16:00:00.000Z",
    durationSeconds: 42,
    isTest: false,
    bookingId: null,
    direction: "inbound",
    summary: null,
    quoCallId: `fixture-call-${id}`,
    recordingUrl: null,
    tag: null,
  };
}

function company(name = COMPANY_NAME) {
  return {
    id: 1,
    name,
    timezone: "America/Edmonton",
    isLive: true,
    jobberConnected: false,
    jobberSkipped: true,
    quoConnected: false,
    setupStatus: {
      accountCreated: true,
      jobberConnected: false,
      jobberSkipped: true,
      jobberResolved: true,
      quoConnected: false,
      phoneProvisioned: true,
      receptionistConfigured: true,
      teamInvited: true,
      isLive: true,
    },
  };
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function installApi(
  page,
  calls,
  { email = OWNER_EMAIL, companyName = COMPANY_NAME } = {},
) {
  return page.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());

    if (pathname === "/api/company") return json(route, company(companyName));
    if (pathname === "/api/me") {
      return json(route, {
        role: "owner",
        teamMemberId: null,
        name: "E2E Owner",
        email,
        companyName,
        canCreateCompany: false,
        canTakeLiveCalls: true,
      });
    }
    if (pathname === "/api/healthz") return json(route, { status: "ok" });
    if (pathname === "/api/calls") return json(route, calls);

    // AppLayout makes several ancillary reads while it mounts. Empty arrays
    // are valid for those unrelated endpoints and keep this test focused on
    // the call list.
    return json(route, []);
  });
}

function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () =>
      http
        .get(url, (response) => {
          response.resume();
          if (response.statusCode && response.statusCode < 500) resolve();
          else if (Date.now() > deadline) reject(new Error(`Failed: ${url}`));
          else setTimeout(attempt, 250);
        })
        .on("error", () => {
          if (Date.now() > deadline) reject(new Error(`Timed out: ${url}`));
          else setTimeout(attempt, 250);
        });
    attempt();
  });
}

async function waitForDashboard(page, callerName) {
  await page.goto(`http://${APP_HOST}:${APP_PORT}/dashboard`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .getByTestId("banner-incoming-call")
    .getByText(new RegExp(callerName))
    .waitFor({ state: "visible" });
  await page.getByTestId("button-live-booking").waitFor({ state: "visible" });
}

async function main() {
  const executablePath = process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (!executablePath) {
    console.error("REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE is not set.");
    process.exit(1);
  }

  const target = call(TARGET_CALL_ID, "Cross-tab Target");
  const other = call(OTHER_CALL_ID, "Other Active Caller");
  const otherOwnerTarget = call(TARGET_CALL_ID, "Other Owner Target");

  try {
    log("Starting cross-tab live-call test server…");
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

    const browser = await chromium.launch({
      executablePath,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    cleanups.push(() => browser.close());
    const context = await browser.newContext();

    // Keep notification and location prompts out of the way. Removing speech
    // recognition makes the launcher own the corner in a deterministic way,
    // while the red incoming banner still exercises the real alert path.
    const preparePage = async () => {
      const page = await context.newPage();
      await page.addInitScript(() => {
        localStorage.setItem("bmc-call-alerts-asked", "yes");
        localStorage.setItem("bmc:device-geo-asked:owner@example.test", "1");
        Object.defineProperty(window, "SpeechRecognition", {
          configurable: true,
          value: undefined,
        });
        Object.defineProperty(window, "webkitSpeechRecognition", {
          configurable: true,
          value: undefined,
        });
      });
      return page;
    };

    const firstPage = await preparePage();
    const secondPage = await preparePage();
    const otherOwnerPage = await preparePage();
    const firstOwnerReturnPage = await preparePage();
    await installApi(firstPage, [target, other]);
    await installApi(secondPage, [target]);
    await installApi(otherOwnerPage, [otherOwnerTarget], {
      email: OTHER_OWNER_EMAIL,
      companyName: OTHER_COMPANY_NAME,
    });
    await installApi(firstOwnerReturnPage, [target]);

    await Promise.all([
      waitForDashboard(firstPage, "Cross-tab Target"),
      waitForDashboard(secondPage, "Cross-tab Target"),
    ]);

    // The alert may already be on either half of its flash cycle by the time
    // the controls are ready, so don't sample document.title as the baseline.
    const secondBaseTitle = BASE_TITLE;
    const titleBeforeDismiss = await secondPage.title();
    check(
      titleBeforeDismiss === BASE_TITLE ||
        titleBeforeDismiss.includes("Cross-tab Target"),
      "the dashboard starts with its normal browser title",
    );
    check(
      (await firstPage
        .getByTestId("button-live-booking")
        .getAttribute("data-state")) === "ringing" &&
        (await secondPage
          .getByTestId("button-live-booking")
          .getAttribute("data-state")) === "ringing",
      "both dashboard tabs show the same incoming call in the banner and launcher",
    );
    await secondPage.waitForFunction(() =>
      document.title.includes("Cross-tab Target"),
    );

    await firstPage
      .getByTestId("button-dismiss-incoming-call")
      .click({ force: true });

    // localStorage events are delivered asynchronously to the other page.
    await secondPage
      .getByTestId("banner-incoming-call")
      .waitFor({ state: "hidden" });
    await secondPage.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="button-live-booking"]')
          ?.getAttribute("data-state") === "idle",
    );
    await secondPage.waitForFunction(
      (baseTitle) => document.title === baseTitle,
      secondBaseTitle,
    );
    check(
      !(await secondPage.getByTestId("banner-incoming-call").isVisible()) &&
        (await secondPage
          .getByTestId("button-live-booking")
          .getAttribute("data-state")) === "idle" &&
        !(await secondPage
          .getByTestId("button-live-booking-dismiss-ringing")
          .isVisible()),
      "dismissing in one tab clears the other tab's live alert and launcher state",
    );
    check(
      (await secondPage.title()) === secondBaseTitle,
      "the other tab restores its normal browser title",
    );

    await waitForDashboard(otherOwnerPage, "Other Owner Target");
    check(
      (await otherOwnerPage
        .getByTestId("button-live-booking")
        .getAttribute("data-state")) === "ringing" &&
        (
          await otherOwnerPage.getByTestId("banner-incoming-call").innerText()
        ).includes("Other Owner Target"),
      "a different owner identity still sees its same-numbered incoming call in the banner and launcher",
    );

    await firstOwnerReturnPage.goto(
      `http://${APP_HOST}:${APP_PORT}/dashboard`,
      {
        waitUntil: "domcontentloaded",
      },
    );
    await firstOwnerReturnPage.getByTestId("button-live-booking").waitFor({
      state: "visible",
    });
    await firstOwnerReturnPage.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="button-live-booking"]')
          ?.getAttribute("data-state") === "idle",
    );
    check(
      !(await firstOwnerReturnPage
        .getByTestId("banner-incoming-call")
        .isVisible()) &&
        (await firstOwnerReturnPage
          .getByTestId("button-live-booking")
          .getAttribute("data-state")) === "idle",
      "returning to the first owner keeps that owner's dismissed call hidden",
    );

    await secondPage.reload({ waitUntil: "domcontentloaded" });
    await secondPage.getByTestId("button-live-booking").waitFor({
      state: "visible",
    });
    await secondPage.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="button-live-booking"]')
          ?.getAttribute("data-state") === "idle",
    );
    check(
      !(await secondPage.getByTestId("banner-incoming-call").isVisible()) &&
        (await secondPage
          .getByTestId("button-live-booking")
          .getAttribute("data-state")) === "idle" &&
        !(await secondPage
          .getByTestId("button-live-booking-dismiss-ringing")
          .isVisible()),
      "a dismissed incoming call stays out of the banner and launcher after a dashboard reload",
    );
    check(
      (await secondPage.title()) === secondBaseTitle,
      "a dashboard reload restores the normal browser title",
    );

    check(
      (
        await firstPage.getByTestId("banner-incoming-call").innerText()
      ).includes("Other Active Caller") &&
        (await firstPage
          .getByTestId("button-live-booking")
          .getAttribute("data-state")) === "ringing",
      "dismissing one call does not stop an unrelated active call in its tab",
    );

    // Switch accounts in this same dashboard tab. The browser stays open and
    // its localStorage survives the account change, so this catches stale
    // in-memory alert state as well as accidental reuse of owner A's seen set.
    await firstPage.unroute("**/api/**");
    await installApi(firstPage, [otherOwnerTarget], {
      email: OTHER_OWNER_EMAIL,
      companyName: OTHER_COMPANY_NAME,
    });
    await waitForDashboard(firstPage, "Other Owner Target");
    check(
      (await firstPage
        .getByTestId("button-live-booking")
        .getAttribute("data-state")) === "ringing" &&
        (
          await firstPage.getByTestId("banner-incoming-call").innerText()
        ).includes("Other Owner Target"),
      "switching owners in the same dashboard tab shows the new owner's same-numbered call in the banner and launcher",
    );

    await firstPage.unroute("**/api/**");
    await installApi(firstPage, [target]);
    await firstPage.reload({ waitUntil: "domcontentloaded" });
    await firstPage.getByTestId("button-live-booking").waitFor({
      state: "visible",
    });
    await firstPage.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="button-live-booking"]')
          ?.getAttribute("data-state") === "idle",
    );
    check(
      !(await firstPage.getByTestId("banner-incoming-call").isVisible()) &&
        (await firstPage
          .getByTestId("button-live-booking")
          .getAttribute("data-state")) === "idle",
      "switching back in the same dashboard tab restores owner A's dismissed alert state",
    );

    target.status = "completed";
    await secondPage.goto(`http://${APP_HOST}:${APP_PORT}/calls`, {
      waitUntil: "domcontentloaded",
    });
    await secondPage.getByText("Cross-tab Target", { exact: true }).waitFor({
      state: "visible",
    });
    check(
      await secondPage.getByText("Completed", { exact: true }).isVisible(),
      "the dismissed call remains available as a completed record in Calls",
    );
  } catch (error) {
    failures.push(`unexpected error: ${error?.stack ?? error}`);
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch {
        // Best effort; the assertion failures above are the useful output.
      }
    }
  }
}

await main();

if (failures.length) {
  log(`\nFAILED (${failures.length}):`);
  for (const failure of failures) log(`  - ${failure}`);
  process.exit(1);
}

log("\nAll cross-tab live-call checks passed.");
