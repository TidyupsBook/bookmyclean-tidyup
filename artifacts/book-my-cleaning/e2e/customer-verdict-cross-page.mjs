/**
 * Browser-level regression for the shared customer verdict.
 *
 * This intentionally uses the same seeded-company shape as the dashboard
 * (one customer represented by a booking, client, invoice, lead and call),
 * while keeping the API in-process so the test is deterministic and safe to
 * run against any development database.
 *
 * Run with:
 *   pnpm --filter @workspace/book-my-cleaning run test:e2e:verdict
 */

import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const artifactDir = path.dirname(fileURLToPath(new URL(".", import.meta.url)));
const APP_HOST = "localhost";
const APP_PORT = 4640;
const failures = [];
const cleanups = [];

const NOW = "2026-08-24T16:00:00.000Z";
const FIRST = {
  booking: 4711,
  client: 4712,
  invoice: 4713,
  lead: 4714,
  call: 4715,
};
const SECOND = {
  booking: 9811,
  client: 9812,
  invoice: 9813,
  lead: 9814,
  call: 9815,
};
const THIRD = {
  booking: 12011,
  client: 12012,
  invoice: 12013,
  lead: 12014,
  call: 12015,
};

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

function recordSet(ids, tag = null) {
  return {
    bookings: [
      {
        id: ids.booking,
        callId: ids.call,
        customerName:
          ids === FIRST ? "Verdict Fixture Customer" : "Other Company Customer",
        customerPhone: "780-555-4711",
        tag,
        customerEmail: null,
        customerAddress: "4711 Test Avenue",
        addressLine2: null,
        addressCity: "Edmonton",
        addressProvince: "AB",
        addressPostal: "T5J 1A1",
        service: "Standard cleaning",
        bedrooms: 2,
        bathrooms: 1,
        extras: [],
        frequency: null,
        internalNotes: null,
        scheduledFor: NOW,
        status: "pending",
        quoteHours: null,
        quoteCrewLabel: null,
        quoteHourlyRate: null,
        quoteFuelSurcharge: null,
        quoteDiscountAmount: null,
        quoteReferralSource: null,
        quotedAmount: null,
        quoteDeposit: null,
        quoteNotes: null,
        quoteMessage: null,
        quoteSentAt: null,
        quoteUrl: null,
        quoteApprovedAt: null,
        clientApprovedAt: null,
        clientApprovedBy: null,
        depositPaidAt: null,
        depositPaidAmount: null,
        quoteTotals: null,
        quoteSentTotals: null,
        needsTimeReview: false,
        timeReviewPreviousTimezone: null,
        jobberSynced: false,
        jobberClientId: null,
        jobberInvoiceId: null,
        jobberInvoiceNumber: null,
        jobberInvoiceWebUri: null,
        jobberSyncError: null,
        jobberSyncErrorAt: null,
        jobberPropertyId: null,
        jobberQuoteId: null,
        jobberQuoteNumber: null,
        jobberQuoteWebUri: null,
        jobberQuoteStatus: null,
        jobberSyncedRequestId: null,
        jobberSyncedQuoteId: null,
        jobberCreatedJobId: null,
        jobberJobWebUri: null,
        jobberWebUri: null,
        lat: null,
        lng: null,
        geocodedAt: null,
        durationMinutes: 120,
        crew: [],
        timerRunningSince: null,
        workedMinutes: 0,
        timeEntries: [],
        createdAt: NOW,
      },
    ],
    clients: [
      {
        id: ids.client,
        name:
          ids === FIRST ? "Verdict Fixture Customer" : "Other Company Customer",
        phone: "780-555-4711",
        phoneE164: "+17805554711",
        tag,
        email: "fixture@example.test",
        streetAddress: "4711 Test Avenue",
        city: "Edmonton",
        province: "AB",
        postalCode: "T5J 1A1",
        jobberClientId: null,
        source: "booking",
        createdAt: NOW,
      },
    ],
    invoices: [
      {
        id: ids.invoice,
        jobberInvoiceId: `fixture-invoice-${ids.invoice}`,
        invoiceNumber: "INV-4711",
        subject: "Standard cleaning",
        clientName:
          ids === FIRST ? "Verdict Fixture Customer" : "Other Company Customer",
        clientPhone: "780-555-4711",
        tag,
        propertyAddress: "4711 Test Avenue, Edmonton, AB",
        status: "awaiting_payment",
        totalCents: 12000,
        balanceCents: 12000,
        jobberWebUri: null,
        issuedAt: NOW,
        dueAt: NOW,
        jobberCreatedAt: NOW,
        lastSyncedAt: NOW,
      },
    ],
    leads: [
      {
        id: ids.lead,
        name:
          ids === FIRST ? "Verdict Fixture Customer" : "Other Company Customer",
        status: "new",
        source: "form",
        sourceTab: null,
        createdAt: NOW,
        createdTime: null,
        phoneDisplay: "780-555-4711",
        phoneE164: "+17805554711",
        email: "fixture@example.test",
        service: "Standard cleaning",
        bedrooms: "2",
        bathrooms: "1",
        dateOfServiceRequested: null,
        heardAbout: null,
        message: null,
        streetAddress: "4711 Test Avenue",
        city: "Edmonton",
        province: "AB",
        postCode: "T5J 1A1",
        platform: null,
        campaignName: null,
        inboxUrl: null,
        jobberSynced: false,
        jobberPushError: null,
        jobberWebUri: null,
        convertedBookingId: ids.booking,
        lat: null,
        lng: null,
        tag,
      },
    ],
    calls: [
      {
        id: ids.call,
        callerName:
          ids === FIRST ? "Verdict Fixture Customer" : "Other Company Customer",
        callerPhone: "780-555-4711",
        status: "booked",
        serviceRequested: "Standard cleaning",
        preferredTime: null,
        startedAt: NOW,
        durationSeconds: 180,
        isTest: false,
        bookingId: ids.booking,
        direction: "inbound",
        summary: "Fixture call",
        quoCallId: `fixture-call-${ids.call}`,
        tag,
      },
    ],
  };
}

function company(companyId) {
  return {
    id: companyId,
    name: companyId === 1 ? "Verdict Fixture Co" : "Other Cleaning Co",
    timezone: "America/Edmonton",
    greeting: "Hello",
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
    quoConnected: false,
    quoWorkspaceName: null,
    quoKeyLast4: null,
    quoNeedsReauth: false,
    watchedNumbers: [],
    bookingRequiredFields: [],
    recentCallWindowMinutes: 30,
    rosterCapacity: 10,
    isLive: true,
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
      completedSteps: 6,
      totalSteps: 6,
    },
    createdAt: NOW,
  };
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

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function tabUntilTestId(page, testId, maxTabs = 80) {
  for (let attempt = 0; attempt < maxTabs; attempt += 1) {
    await page.keyboard.press("Tab");
    const focusedTestId = await page.evaluate(
      () => document.activeElement?.getAttribute("data-testid") ?? null,
    );
    if (focusedTestId === testId) return true;
  }
  return false;
}

async function showFixtureBooking(page, id) {
  await page.getByTestId("button-queue-awaiting_response").click();
  await page.getByTestId(`card-booking-${id}`).waitFor({ state: "visible" });
}

function installApi(page, records, companyId) {
  return page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;

    if (pathname === "/api/company") return json(route, company(companyId));
    if (pathname === "/api/me")
      return json(route, {
        role: "owner",
        teamMemberId: null,
        name: "E2E Owner",
        email: "owner@example.test",
        companyName: company(companyId).name,
        canCreateCompany: false,
        canTakeLiveCalls: true,
      });
    if (pathname === "/api/healthz") return json(route, { status: "ok" });
    if (pathname === "/api/bookings") return json(route, records.bookings);
    if (pathname === "/api/clients") return json(route, records.clients);
    if (pathname === "/api/jobber-invoices")
      return json(route, records.invoices);
    if (pathname === "/api/calls") return json(route, records.calls);
    if (pathname === "/api/leads") return json(route, records.leads);

    const callDetailMatch = pathname.match(/^\/api\/calls\/(\d+)$/);
    if (callDetailMatch && request.method() === "GET") {
      const call = records.calls.find(
        (item) => item.id === Number(callDetailMatch[1]),
      );
      if (!call) return json(route, { error: "Call not found" }, 404);
      return json(route, {
        ...call,
        recordingUrl: null,
        notes: null,
        transcript: [],
        extractedAnswers: [],
      });
    }

    const leadTagMatch = pathname.match(/^\/api\/leads\/(\d+)\/tag$/);
    if (leadTagMatch && request.method() === "PATCH") {
      const id = Number(leadTagMatch[1]);
      const lead = records.leads.find((item) => item.id === id);
      if (!lead) return json(route, { error: "Lead not found" }, 404);
      const body = request.postDataJSON();
      const nextTag = body?.tag ?? null;
      lead.tag = nextTag;
      for (const item of records.bookings) item.tag = nextTag;
      for (const item of records.clients) item.tag = nextTag;
      for (const item of records.invoices) item.tag = nextTag;
      for (const item of records.calls) item.tag = nextTag;
      return json(route, { ...lead, tag: nextTag });
    }

    const match = pathname.match(
      /^\/api\/customer-tags\/(lead|call|booking|invoice|client)\/(\d+)$/,
    );
    if (match && request.method() === "PATCH") {
      const [, kind, rawId] = match;
      const id = Number(rawId);
      const row = records[`${kind}s`]?.find((item) => item.id === id);
      if (!row) return json(route, { error: "Record not found" }, 404);
      const body = request.postDataJSON();
      const nextTag = body?.tag ?? null;
      for (const list of Object.values(records)) {
        for (const item of list) {
          if (
            item.id === id ||
            (item.id >= FIRST.booking && item.id <= FIRST.call)
          ) {
            item.tag = nextTag;
          }
        }
      }
      return json(route, { kind, id, tag: nextTag });
    }

    // AppLayout and calls' attention store make ancillary reads during
    // navigation; empty arrays are valid for those unrelated endpoints.
    return json(route, []);
  });
}

async function main() {
  const executablePath = process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (!executablePath) {
    console.error("REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE is not set.");
    process.exit(1);
  }

  try {
    log("Starting verdict-flow test server…");
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

    const firstRecords = recordSet(FIRST);
    const firstPage = await browser.newPage();
    await firstPage.addInitScript(() => {
      localStorage.setItem("bmc-call-alerts-asked", "yes");
      localStorage.setItem("bmc:device-geo-asked:owner@example.test", "1");
    });
    await installApi(firstPage, firstRecords, 1);

    await firstPage.goto(`http://${APP_HOST}:${APP_PORT}/calls`, {
      waitUntil: "domcontentloaded",
    });
    await firstPage.waitForSelector(
      `[data-testid="chip-tag-call-${FIRST.call}"]`,
      { state: "detached" },
    );
    await firstPage.keyboard.press("Escape");
    const permissionDialog = firstPage.getByRole("dialog");
    if (await permissionDialog.count()) {
      await permissionDialog.locator("button").last().click({ force: true });
      await permissionDialog.waitFor({ state: "hidden" });
    }
    const callAlertsLater = firstPage.getByTestId("button-call-alerts-later");
    if (await callAlertsLater.count()) await callAlertsLater.click();
    await firstPage
      .getByTestId(`button-tag-call-list-${FIRST.call}-client`)
      .click();
    await firstPage.waitForFunction((testId) => {
      return (
        document
          .querySelector(`[data-testid="${testId}"]`)
          ?.getAttribute("aria-pressed") === "true"
      );
    }, `button-tag-call-list-${FIRST.call}-client`);
    await firstPage
      .getByTestId(`chip-tag-call-${FIRST.call}`)
      .waitFor({ state: "visible" });

    await firstPage.goto(`http://${APP_HOST}:${APP_PORT}/bookings`, {
      waitUntil: "domcontentloaded",
    });
    await showFixtureBooking(firstPage, FIRST.booking);
    await firstPage
      .getByTestId(`chip-tag-booking-${FIRST.booking}`)
      .waitFor({ state: "visible" });
    check(
      (await firstPage
        .getByTestId(`chip-tag-booking-${FIRST.booking}`)
        .innerText()) === "Client" &&
        (await firstPage
          .getByTestId(`button-tag-booking-${FIRST.booking}-client`)
          .getAttribute("aria-pressed")) === "true",
      "owner can set Client from Calls and the booking chip and picker agree",
    );

    await firstPage.goto(`http://${APP_HOST}:${APP_PORT}/clients`, {
      waitUntil: "domcontentloaded",
    });
    await firstPage
      .getByTestId(`chip-tag-client-${FIRST.client}`)
      .waitFor({ state: "visible" });
    check(
      (await firstPage
        .getByTestId(`chip-tag-client-${FIRST.client}`)
        .innerText()) === "Client",
      "the client shows the shared verdict",
    );
    await firstPage
      .getByTestId(`button-tag-client-${FIRST.client}-client`)
      .click();

    await firstPage.goto(`http://${APP_HOST}:${APP_PORT}/invoices`, {
      waitUntil: "domcontentloaded",
    });
    await firstPage
      .getByTestId(`chip-tag-invoice-${FIRST.invoice}`)
      .waitFor({ state: "hidden" });
    await firstPage.reload({ waitUntil: "domcontentloaded" });
    check(
      !(await firstPage
        .getByTestId(`chip-tag-invoice-${FIRST.invoice}`)
        .isVisible()) &&
        (await firstPage
          .getByTestId(`button-tag-invoice-${FIRST.invoice}-client`)
          .getAttribute("aria-pressed")) === "false",
      "clearing from Clients stays cleared after navigating and reloading Invoices",
    );

    await firstPage.goto(`http://${APP_HOST}:${APP_PORT}/leads`, {
      waitUntil: "domcontentloaded",
    });
    await firstPage.getByTestId(`button-toggle-lead-${FIRST.lead}`).click();
    await firstPage.getByTestId(`button-tag-lead-${FIRST.lead}-client`).click();
    await firstPage
      .getByTestId(`chip-tag-lead-${FIRST.lead}`)
      .waitFor({ state: "visible" });

    await firstPage.goto(`http://${APP_HOST}:${APP_PORT}/bookings`, {
      waitUntil: "domcontentloaded",
    });
    await showFixtureBooking(firstPage, FIRST.booking);
    await firstPage
      .getByTestId(`chip-tag-booking-${FIRST.booking}`)
      .waitFor({ state: "visible" });
    check(
      (await firstPage
        .getByTestId(`chip-tag-booking-${FIRST.booking}`)
        .innerText()) === "Client" &&
        (await firstPage
          .getByTestId(`button-tag-booking-${FIRST.booking}-client`)
          .getAttribute("aria-pressed")) === "true",
      "setting Client from Leads updates the related booking",
    );
    await firstPage.reload({ waitUntil: "domcontentloaded" });
    await showFixtureBooking(firstPage, FIRST.booking);
    check(
      (await firstPage
        .getByTestId(`chip-tag-booking-${FIRST.booking}`)
        .innerText()) === "Client",
      "the lead verdict remains on the booking after reloading",
    );

    await firstPage.goto(`http://${APP_HOST}:${APP_PORT}/leads`, {
      waitUntil: "domcontentloaded",
    });
    await firstPage.getByTestId(`button-toggle-lead-${FIRST.lead}`).click();
    await firstPage.getByTestId(`button-tag-lead-${FIRST.lead}-client`).click();
    await firstPage
      .getByTestId(`chip-tag-lead-${FIRST.lead}`)
      .waitFor({ state: "hidden" });

    await firstPage.goto(`http://${APP_HOST}:${APP_PORT}/bookings`, {
      waitUntil: "domcontentloaded",
    });
    await showFixtureBooking(firstPage, FIRST.booking);
    await firstPage
      .getByTestId(`chip-tag-booking-${FIRST.booking}`)
      .waitFor({ state: "hidden" });
    await firstPage.reload({ waitUntil: "domcontentloaded" });
    await showFixtureBooking(firstPage, FIRST.booking);
    check(
      !(await firstPage
        .getByTestId(`chip-tag-booking-${FIRST.booking}`)
        .isVisible()) &&
        (await firstPage
          .getByTestId(`button-tag-booking-${FIRST.booking}-client`)
          .getAttribute("aria-pressed")) === "false",
      "clearing Client from Leads clears the booking after navigation and reload",
    );

    // The spreadsheet has its own TagPicker and mutation path. Keep this
    // separate from the card assertions above so a refactor can break one
    // rendering path without making the other test fail first.
    await firstPage.setViewportSize({ width: 390, height: 844 });
    await firstPage.evaluate(() => {
      localStorage.setItem(
        "leads-table-columns-v2",
        JSON.stringify([
          "email",
          "service",
          "address",
          "requested",
          "source",
          "status",
          "received",
        ]),
      );
    });
    await firstPage.goto(`http://${APP_HOST}:${APP_PORT}/leads`, {
      waitUntil: "domcontentloaded",
    });
    await firstPage.getByTestId("view-table").click();
    const firstLeadRow = firstPage.getByTestId(`lead-row-${FIRST.lead}`);
    await firstLeadRow.waitFor({ state: "visible" });
    const leadsTable = firstPage.getByTestId("leads-table");
    const tableGrid = firstPage.getByTestId("leads-table-grid");
    await firstPage.waitForFunction(() => {
      const region = document.querySelector('[data-testid="leads-table"]');
      return (
        region instanceof HTMLElement && region.scrollWidth > region.clientWidth
      );
    });
    const scrollMetrics = await leadsTable.evaluate((region) => {
      const actions = region.querySelector('[data-column="actions"]');
      if (
        !(region instanceof HTMLElement) ||
        !(actions instanceof HTMLElement)
      ) {
        return null;
      }
      region.scrollTo({ left: region.scrollWidth, behavior: "instant" });
      const regionBox = region.getBoundingClientRect();
      const actionsBox = actions.getBoundingClientRect();
      return {
        hasOverflow: region.scrollWidth > region.clientWidth,
        actionsVisible:
          actionsBox.left < regionBox.right &&
          actionsBox.right > regionBox.left,
        actionsRight: actionsBox.right,
        regionRight: regionBox.right,
      };
    });
    check(
      scrollMetrics?.hasOverflow === true &&
        scrollMetrics.actionsVisible === true &&
        Math.abs(scrollMetrics.actionsRight - scrollMetrics.regionRight) < 2,
      "the narrow Leads spreadsheet scrolls sideways while keeping Actions reachable",
    );
    check(
      (await tableGrid.getAttribute("data-minimum-width")) === "1488" &&
        (await firstPage
          .getByTestId(`table-button-tag-lead-${FIRST.lead}-good_lead`)
          .isVisible()),
      "all optional columns stay enabled without removing spreadsheet verdict controls",
    );

    // Start from a fresh table so this path proves keyboard access without
    // relying on the pointer-driven horizontal scroll check above. The region
    // is intentionally in the tab order before the table's descendants, and
    // the sticky Actions cell remains in normal DOM order after every optional
    // column.
    await firstPage.goto(`http://${APP_HOST}:${APP_PORT}/leads`, {
      waitUntil: "domcontentloaded",
    });
    await firstPage.getByTestId("view-table").click();
    await firstPage.getByTestId(`lead-row-${FIRST.lead}`).waitFor({
      state: "visible",
    });
    await firstPage.getByTestId("view-table").focus();
    check(
      await tabUntilTestId(firstPage, "leads-table"),
      "Tab navigation reaches the labeled horizontal Leads scroll region",
    );
    const firstVerdictTestId = `table-button-tag-lead-${FIRST.lead}-client`;
    check(
      await tabUntilTestId(firstPage, firstVerdictTestId),
      "Tab navigation reaches the sticky Actions controls",
    );
    const focusedVerdicts = [];
    for (const tag of ["client", "good_lead", "bad_lead", "spam"]) {
      if (tag !== "client") await firstPage.keyboard.press("Tab");
      focusedVerdicts.push(
        await firstPage.evaluate(
          () => document.activeElement?.getAttribute("data-testid") ?? null,
        ),
      );
    }
    check(
      focusedVerdicts.every(
        (testId, index) =>
          testId ===
          `table-button-tag-lead-${FIRST.lead}-${["client", "good_lead", "bad_lead", "spam"][index]}`,
      ),
      "Tab navigation reaches every Leads verdict button in order",
    );
    await firstPage.keyboard.press("Shift+Tab");
    await firstPage.keyboard.press("Shift+Tab");
    await firstPage.keyboard.press("Space");
    await firstPage.waitForFunction((testId) => {
      return (
        document
          .querySelector(`[data-testid="${testId}"]`)
          ?.getAttribute("aria-pressed") === "true"
      );
    }, `table-button-tag-lead-${FIRST.lead}-good_lead`);
    check(
      (await firstPage
        .getByTestId(`table-button-tag-lead-${FIRST.lead}-good_lead`)
        .getAttribute("aria-pressed")) === "true",
      "keyboard activation changes a Leads verdict without pointer scrolling",
    );

    await firstPage
      .getByTestId(`table-button-tag-lead-${FIRST.lead}-good_lead`)
      .click();
    await firstPage.waitForFunction((testId) => {
      return (
        document
          .querySelector(`[data-testid="${testId}"]`)
          ?.getAttribute("aria-pressed") === "false"
      );
    }, `table-button-tag-lead-${FIRST.lead}-good_lead`);
    await firstPage
      .getByTestId(`table-button-tag-lead-${FIRST.lead}-good_lead`)
      .click();
    await firstPage.waitForFunction((testId) => {
      return (
        document
          .querySelector(`[data-testid="${testId}"]`)
          ?.getAttribute("aria-pressed") === "true"
      );
    }, `table-button-tag-lead-${FIRST.lead}-good_lead`);
    check(
      (await firstPage
        .getByTestId(`table-button-tag-lead-${FIRST.lead}-good_lead`)
        .getAttribute("aria-pressed")) === "true",
      "the Leads spreadsheet can set Good lead",
    );

    await firstPage.goto(`http://${APP_HOST}:${APP_PORT}/bookings`, {
      waitUntil: "domcontentloaded",
    });
    await showFixtureBooking(firstPage, FIRST.booking);
    await firstPage
      .getByTestId(`chip-tag-booking-${FIRST.booking}`)
      .waitFor({ state: "visible" });
    check(
      (await firstPage
        .getByTestId(`chip-tag-booking-${FIRST.booking}`)
        .innerText()) === "Good lead" &&
        (await firstPage
          .getByTestId(`button-tag-booking-${FIRST.booking}-good_lead`)
          .getAttribute("aria-pressed")) === "true",
      "setting Good lead in the spreadsheet updates the related booking",
    );
    await firstPage.reload({ waitUntil: "domcontentloaded" });
    await showFixtureBooking(firstPage, FIRST.booking);
    check(
      (await firstPage
        .getByTestId(`chip-tag-booking-${FIRST.booking}`)
        .innerText()) === "Good lead",
      "the spreadsheet verdict remains on the booking after reloading",
    );

    await firstPage.goto(`http://${APP_HOST}:${APP_PORT}/leads`, {
      waitUntil: "domcontentloaded",
    });
    await firstPage.getByTestId("view-table").click();
    await firstPage
      .getByTestId(`table-button-tag-lead-${FIRST.lead}-good_lead`)
      .click();
    await firstPage.goto(`http://${APP_HOST}:${APP_PORT}/bookings`, {
      waitUntil: "domcontentloaded",
    });
    await showFixtureBooking(firstPage, FIRST.booking);
    await firstPage
      .getByTestId(`chip-tag-booking-${FIRST.booking}`)
      .waitFor({ state: "hidden" });
    await firstPage.reload({ waitUntil: "domcontentloaded" });
    await showFixtureBooking(firstPage, FIRST.booking);
    check(
      !(await firstPage
        .getByTestId(`chip-tag-booking-${FIRST.booking}`)
        .isVisible()) &&
        (await firstPage
          .getByTestId(`button-tag-booking-${FIRST.booking}-good_lead`)
          .getAttribute("aria-pressed")) === "false",
      "clearing Good lead in the spreadsheet clears the booking after reload",
    );

    const secondRecords = recordSet(SECOND);
    const secondPage = await browser.newPage();
    await secondPage.addInitScript(() => {
      localStorage.setItem("bmc-call-alerts-asked", "yes");
      localStorage.setItem("bmc:device-geo-asked:owner@example.test", "1");
    });
    await installApi(secondPage, secondRecords, 2);
    await secondPage.goto(`http://${APP_HOST}:${APP_PORT}/clients`, {
      waitUntil: "domcontentloaded",
    });
    check(
      !(await secondPage
        .getByText("Verdict Fixture Customer", { exact: true })
        .count()),
      "a second company cannot see the first company's customer",
    );
    await secondPage.goto(`http://${APP_HOST}:${APP_PORT}/leads`, {
      waitUntil: "domcontentloaded",
    });
    await secondPage.getByTestId("view-table").click();
    check(
      (await secondPage.getByTestId(`lead-row-${SECOND.lead}`).count()) === 1 &&
        (await secondPage.getByTestId(`lead-row-${FIRST.lead}`).count()) === 0,
      "a second company cannot read the first company's lead from the spreadsheet",
    );
    const crossCompany = await secondPage.evaluate(async (id) => {
      const response = await fetch(`/api/customer-tags/client/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: "spam" }),
      });
      return response.status;
    }, FIRST.client);
    check(
      crossCompany === 404,
      "a second company cannot change the first company's verdict",
    );
    const crossCompanyLeadPatch = await secondPage.evaluate(async (id) => {
      const response = await fetch(`/api/leads/${id}/tag`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: "spam" }),
      });
      return response.status;
    }, FIRST.lead);
    check(
      crossCompanyLeadPatch === 404,
      "a second company cannot change the first lead's verdict",
    );

    // Keep the call-row interaction contract on a fresh page and fixture
    // set. The cross-page checks above intentionally mutate every related
    // record, while these assertions need to isolate row navigation from
    // verdict saves.
    const interactionPage = await browser.newPage();
    await interactionPage.addInitScript(() => {
      localStorage.setItem("bmc-call-alerts-asked", "yes");
      localStorage.setItem("bmc:device-geo-asked:owner@example.test", "1");
    });
    await installApi(interactionPage, recordSet(THIRD), 3);
    await interactionPage.goto(`http://${APP_HOST}:${APP_PORT}/calls`, {
      waitUntil: "domcontentloaded",
    });
    await interactionPage.waitForSelector(
      `[data-testid="chip-tag-call-${THIRD.call}"]`,
      { state: "detached" },
    );
    await interactionPage.keyboard.press("Escape");
    const interactionPermissionDialog = interactionPage.getByRole("dialog");
    if (await interactionPermissionDialog.count()) {
      await interactionPermissionDialog
        .locator("button")
        .last()
        .click({ force: true });
      await interactionPermissionDialog.waitFor({ state: "hidden" });
    }
    const interactionAlertsLater = interactionPage.getByTestId(
      "button-call-alerts-later",
    );
    if (await interactionAlertsLater.count()) {
      await interactionAlertsLater.click();
    }
    const interactionClientTag = interactionPage.getByTestId(
      `button-tag-call-list-${THIRD.call}-client`,
    );
    await interactionClientTag.click();
    await interactionPage.waitForFunction((testId) => {
      return (
        document
          .querySelector(`[data-testid="${testId}"]`)
          ?.getAttribute("aria-pressed") === "true"
      );
    }, `button-tag-call-list-${THIRD.call}-client`);
    check(
      (await interactionPage.getByRole("dialog").count()) === 0,
      "selecting a Calls verdict does not open call details",
    );
    await interactionClientTag.click();
    await interactionPage.waitForFunction((testId) => {
      return (
        document
          .querySelector(`[data-testid="${testId}"]`)
          ?.getAttribute("aria-pressed") === "false"
      );
    }, `button-tag-call-list-${THIRD.call}-client`);
    check(
      (await interactionPage.getByRole("dialog").count()) === 0,
      "clearing a Calls verdict does not open call details",
    );
    const interactionGoodLeadTag = interactionPage.getByTestId(
      `button-tag-call-list-${THIRD.call}-good_lead`,
    );
    await interactionGoodLeadTag.focus();
    await interactionGoodLeadTag.press("Enter");
    await interactionPage.waitForFunction((testId) => {
      return (
        document
          .querySelector(`[data-testid="${testId}"]`)
          ?.getAttribute("aria-pressed") === "true"
      );
    }, `button-tag-call-list-${THIRD.call}-good_lead`);
    check(
      (await interactionPage.getByRole("dialog").count()) === 0,
      "keyboard verdict activation does not open call details",
    );
    await interactionPage
      .getByText("Other Company Customer", { exact: true })
      .click();
    await interactionPage.getByRole("dialog").waitFor({ state: "visible" });
    check(
      await interactionPage.getByRole("dialog").isVisible(),
      "clicking outside verdict controls still opens call details",
    );
    await interactionPage.getByRole("button", { name: "Close" }).click();
    await interactionPage.getByRole("dialog").waitFor({ state: "hidden" });
  } catch (error) {
    failures.push(`unexpected error: ${error?.stack ?? error}`);
    log(`  ✗ ${error?.stack ?? error}`);
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
    failures.forEach((failure) => log(`  - ${failure}`));
    process.exit(1);
  }
  log("\nAll cross-page verdict checks passed.");
}

await main();
