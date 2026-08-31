/**
 * Browser-level guard: re-pricing an already-sent quote must keep the booking
 * card honest — the card must show the original (frozen) sent total alongside
 * the new "now $X" divergence notice, and the card button must still read
 * "Adjust quote" (not revert to "Create quote").
 *
 * Strategy
 * --------
 * Uses the same always-signed-in Clerk mock and dedicated Vite config as the
 * quote-save-redraft test. The booking starts with quoteSentAt and
 * quoteSentTotals already populated (3 h × $50 = $150). After the owner
 * picks 4 hours (new total $200) and saves, the mock returns the updated
 * shape — sentTotals stays $150, currentTotals rises to $200 — and the card
 * must show both.
 *
 * Assertions (in order):
 *   1. Card button reads "Adjust quote" (a price was already set + sent)
 *   2. Dialog opens with the calculator visible (pricing entry mode)
 *   3. The "4" hours chip is clicked — Save price becomes enabled
 *   4. Press Save price — PATCH fires, send-quote must NOT fire
 *   5. Close the dialog — card still reads "Adjust quote"
 *   6. Card shows the frozen sent total "$150.00"
 *   7. Card shows the divergence notice "now $200.00"
 *
 * Run: pnpm --filter @workspace/book-my-cleaning run test:e2e:quote-sent-reprice
 */

import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const artifactDir = path.dirname(fileURLToPath(new URL(".", import.meta.url)));
const APP_HOST = "localhost";
const APP_PORT = 4632;

const BOOKING_ID = 43;

/** The total that was texted to the customer (frozen). */
const SENT_TOTAL = 150;
const SENT_TOTAL_TEXT = "$150.00";

/** The total after re-pricing (4 h × $50/hr). */
const REPRICED_TOTAL = 200;
const REPRICED_TOTAL_TEXT = "$200.00";

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

function makeSentTotals(total) {
  return {
    subtotal: total,
    total,
    taxRate: 0,
    taxLabel: "GST",
    taxAmount: 0,
    feesRate: 0,
    feesLabel: "Fees",
    feesAmount: 0,
    depositAmount: 0,
    lineItems: [
      {
        name: "Regular cleaning",
        quantity: total / 50,
        unitPrice: 50,
      },
    ],
  };
}

/**
 * Build a booking shape.
 *
 * repriced=false → both sentTotals and currentTotals are $150 (no divergence)
 * repriced=true  → sentTotals stays $150, currentTotals rises to $200
 */
function makeBooking({ repriced }) {
  const currentTotal = repriced ? REPRICED_TOTAL : SENT_TOTAL;
  return {
    id: BOOKING_ID,
    status: "pending",
    service: "Regular cleaning",
    customerName: "Quinn Quoted",
    customerPhone: "+17805550198",
    streetAddress: "456 Oak Ave",
    city: "Edmonton",
    province: "AB",
    postCode: "T5K 1B4",
    scheduledFor: new Date(Date.now() + 7 * 86400_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    notes: null,
    crew: [],
    bedrooms: "3",
    bathrooms: "2",
    quotedAmount: null,
    quoteHours: currentTotal / 50,
    quoteCrewLabel: null,
    quoteHourlyRate: 50,
    quoteFuelSurcharge: null,
    quoteDiscountAmount: null,
    quoteReferralSource: null,
    quoteDeposit: null,
    // Current (live) totals — changes after reprice
    quoteTotals: makeSentTotals(currentTotal),
    // Frozen sent totals — always stays at $150
    quoteSentAt: new Date(Date.now() - 3600_000).toISOString(),
    quoteSentTotals: makeSentTotals(SENT_TOTAL),
    quoteMessage: `Hi Quinn! Your quote is ${SENT_TOTAL_TEXT} — let us know if you'd like to book!`,
    clientApprovedBy: null,
    clientApprovedAt: null,
    depositPaidAt: null,
    jobberSynced: false,
    jobberSyncedRequestId: null,
    jobberSyncedQuoteId: null,
    jobberCreatedJobId: null,
    jobberWebUri: null,
    jobberQuoteWebUri: null,
    jobberInvoiceId: null,
    jobberInvoiceNumber: null,
    jobberClientId: null,
    jobberSyncError: null,
    source: null,
    sourceCallId: null,
    pendingSync: false,
  };
}

function makePreview({ repriced }) {
  const currentTotal = repriced ? REPRICED_TOTAL : SENT_TOTAL;
  const totalText = repriced ? REPRICED_TOTAL_TEXT : SENT_TOTAL_TEXT;
  return {
    message: `Hi Quinn! Your updated quote is ${totalText} — let us know if you'd like to book!`,
    canSend: true,
    blockedReason: null,
    fromNumber: "+17805550000",
    totals: makeSentTotals(currentTotal),
  };
}

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
  // 1. Start a dedicated dev server with the Clerk-mock Vite config.
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

  // Pre-seed localStorage to suppress one-time permission dialogs.
  const E2E_EMAIL = "e2e@test.example";
  await context.addInitScript((email) => {
    window.localStorage.setItem(`bmc:device-geo-asked:${email}`, "1");
    window.localStorage.setItem("bmc-call-alerts-asked", "yes");
  }, E2E_EMAIL);

  const page = await context.newPage();

  // Track mutations — send-quote must NEVER be called.
  let sendQuoteCalled = false;
  // Flips to true once the PATCH lands; subsequent GET /bookings returns the
  // post-reprice shape (sentTotals=$150, currentTotals=$200).
  let repriced = false;

  // 3. Mock the backend API.
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const { pathname } = url;
    const method = req.method();

    // --- /api/me ---
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

    // --- /api/company ---
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
          quoteRateSolo: 50,
          quoteRateTeam: 80,
          quoteFuelSurcharge: 0,
          quoteDepositAmount: 0,
          quoteTaxRate: 0,
          quoteTaxLabel: "GST",
          quoteFeesRate: 0,
          quoteFeesLabel: "Fees",
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

    // --- send-quote — must NOT be hit ---
    if (
      pathname === `/api/bookings/${BOOKING_ID}/send-quote` &&
      method === "POST"
    ) {
      sendQuoteCalled = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeBooking({ repriced: true })),
      });
    }

    // --- quote-preview ---
    if (pathname === `/api/bookings/${BOOKING_ID}/quote-preview`) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makePreview({ repriced })),
      });
    }

    // --- PATCH booking (Save price) ---
    if (pathname === `/api/bookings/${BOOKING_ID}` && method === "PATCH") {
      repriced = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeBooking({ repriced: true })),
      });
    }

    // --- GET bookings list ---
    if (pathname === "/api/bookings" || pathname.startsWith("/api/bookings?")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([makeBooking({ repriced })]),
      });
    }

    // --- team members ---
    if (pathname === "/api/team") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    }

    // --- map ---
    if (pathname.startsWith("/api/map")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ configured: false }),
      });
    }

    // --- healthz ---
    if (pathname === "/api/healthz") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok" }),
      });
    }

    // --- absorb everything else ---
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  // 4. Navigate to the Bookings page.
  log("\nNavigating to /bookings …");
  await page.goto(`http://${APP_HOST}:${APP_PORT}/bookings`, {
    waitUntil: "domcontentloaded",
  });

  // ── Assertion 1: card button reads "Adjust quote" from the start ─────────
  // The booking already has a price (quoteTotals.subtotal > 0), so hasQuotePrice
  // returns true and the label must be "Adjust quote" before any interaction.
  const quotePriceBtn = page.locator(
    `[data-testid="button-quote-price-${BOOKING_ID}"]`,
  );
  let initialBtnText = "";
  try {
    await quotePriceBtn.waitFor({ timeout: 15_000 });
    initialBtnText = (await quotePriceBtn.innerText()).trim();
  } catch {
    const body = await page
      .evaluate(() => document.body?.innerText ?? "")
      .catch(() => "(unreachable)");
    log(`  Page text at failure:\n${body.slice(0, 800)}`);
  }
  check(
    initialBtnText === "Adjust quote",
    `card button reads "Adjust quote" before reprice (got "${initialBtnText}")`,
  );

  // ── Open the quote dialog ────────────────────────────────────────────────
  log("\nOpening quote dialog …");
  await quotePriceBtn.click({ force: true });

  // ── Assertion 2: dialog opens with the calculator visible ────────────────
  // For an already-priced booking the dialog opens in "pricing" mode, so the
  // calculator (Save price button) should be present immediately.
  const savePriceBtn = page.locator('[data-testid="button-save-price"]');
  let calcVisible = false;
  try {
    await savePriceBtn.waitFor({ timeout: 10_000 });
    calcVisible = true;
  } catch {
    // also try the "adjust price" button which may appear for priced bookings
    try {
      const adjustBtn = page.locator('[data-testid="button-adjust-price"]');
      await adjustBtn.waitFor({ timeout: 3_000 });
      await adjustBtn.click();
      await savePriceBtn.waitFor({ timeout: 5_000 });
      calcVisible = true;
    } catch {
      // calculator not found
    }
  }
  check(
    calcVisible,
    "quote calculator (Save price button) is visible in dialog",
  );

  // ── Click the "4" hours chip to increase the total ──────────────────────
  // 4 h × $50/hr = $200, up from the sent $150.
  log("\nClicking the '4' hours chip …");
  let hoursChipFound = false;
  try {
    const chip4 = page
      .locator('button[type="button"][aria-pressed]')
      .filter({ hasText: /^4$/ })
      .first();
    await chip4.waitFor({ timeout: 5_000 });
    await chip4.click();
    hoursChipFound = true;
  } catch {
    log("  Could not find '4' hours chip via aria-pressed — trying by text");
    try {
      const btn = page.locator("button").filter({ hasText: /^4$/ }).first();
      await btn.waitFor({ timeout: 3_000 });
      await btn.click();
      hoursChipFound = true;
    } catch {
      // will fail later
    }
  }
  check(hoursChipFound, 'clicked the "4" hours chip');

  // ── Assertion 3: Save price becomes enabled ──────────────────────────────
  let saveBtnEnabled = false;
  try {
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('[data-testid="button-save-price"]');
        return btn && !btn.disabled;
      },
      { timeout: 5_000 },
    );
    saveBtnEnabled = await savePriceBtn.isEnabled();
  } catch {
    try {
      saveBtnEnabled = await savePriceBtn.isEnabled();
    } catch {
      // not available
    }
  }
  check(
    saveBtnEnabled,
    '"Save price" button is enabled after selecting 4 hours',
  );

  // ── Click Save price ─────────────────────────────────────────────────────
  log("\nClicking Save price …");
  if (saveBtnEnabled) {
    await savePriceBtn.click();
  }

  // Wait for the toast and any re-fetch to settle.
  await page.waitForTimeout(500);

  // ── Assertion 4: send-quote endpoint was NOT called ──────────────────────
  check(
    !sendQuoteCalled,
    "send-quote endpoint was never called during Save price",
  );

  // ── Close the dialog ─────────────────────────────────────────────────────
  log("\nClosing dialog …");
  const cancelBtn = page.getByRole("button", { name: "Cancel" });
  try {
    await cancelBtn.waitFor({ timeout: 5_000 });
    await cancelBtn.click();
  } catch {
    await page.keyboard.press("Escape");
  }

  // Wait for the dialog to close and the card to re-render.
  await page.waitForTimeout(600);

  // ── Assertion 5: card button still reads "Adjust quote" ─────────────────
  let afterBtnText = "";
  try {
    await quotePriceBtn.waitFor({ timeout: 8_000 });
    afterBtnText = (await quotePriceBtn.innerText()).trim();
  } catch {
    afterBtnText = "(button not found after close)";
  }
  check(
    afterBtnText === "Adjust quote",
    `card button still reads "Adjust quote" after reprice (got "${afterBtnText}")`,
  );

  // ── Assertion 6: frozen sent total is the card headline ─────────────────
  // BookingDetailDialog.tsx renders BookingPrice inside the booking card.
  // When quoteSentAt is set, BookingPrice leads with quoteSentTotals.total in
  // a span marked data-testid="price-sent-total-<id>". We wait for that
  // specific element and read its text — no document-wide search.
  const sentTotalEl = page.locator(
    `[data-testid="price-sent-total-${BOOKING_ID}"]`,
  );
  let sentTotalText = "";
  try {
    await sentTotalEl.waitFor({ timeout: 8_000 });
    sentTotalText = (await sentTotalEl.innerText()).trim();
  } catch {
    sentTotalText = "(element not found)";
  }
  check(
    sentTotalText === SENT_TOTAL_TEXT,
    `price-sent-total element shows "${SENT_TOTAL_TEXT}" (got "${sentTotalText}")`,
  );

  // ── Assertion 7: divergence notice shows "now $200.00" in amber ──────────
  // BookingPrice renders a span[data-testid="price-divergence-notice-<id>"]
  // with class "text-amber-400" only when |sent - current| >= $0.01.
  // Assert both the exact text content and the amber class.
  const divergenceEl = page.locator(
    `[data-testid="price-divergence-notice-${BOOKING_ID}"]`,
  );
  let divergenceText = "";
  let divergenceIsAmber = false;
  try {
    await divergenceEl.waitFor({ timeout: 8_000 });
    divergenceText = (await divergenceEl.innerText()).trim();
    const classList = await divergenceEl.getAttribute("class");
    divergenceIsAmber = (classList ?? "").includes("text-amber-400");
  } catch {
    divergenceText = "(element not found)";
  }
  check(
    divergenceText === `now ${REPRICED_TOTAL_TEXT}`,
    `divergence notice text is "now ${REPRICED_TOTAL_TEXT}" (got "${divergenceText}")`,
  );
  check(divergenceIsAmber, 'divergence notice has class "text-amber-400"');
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
log("\nAll quote-sent-reprice checks passed.");
process.exit(0);
