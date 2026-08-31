/**
 * Browser-level guard: saving a quote price must redraft the message to show
 * the new total, update the booking card, and must never fire the send-quote
 * endpoint — all without reloading or reopening the dialog.
 *
 * Strategy
 * --------
 * The same always-signed-in Clerk mock and dedicated Vite config used by
 * leads-sheet-badge.mjs keeps this test self-contained. The API is fully
 * mocked via page.route(); a boolean flag (`priceSaved`) flips once the PATCH
 * lands so the quote-preview and bookings routes can return the post-save
 * shape without real database traffic.
 *
 * Assertions (in order):
 *   1. Card button reads "Create quote" (booking has no price yet)
 *   2. Dialog opens showing the no-price warning
 *   3. Fill in 3 h × $50/hr in the calculator (Save price enabled)
 *   4. Press Save price — no send-quote POST fires
 *   5. Message textarea now contains the saved total "$150.00"
 *   6. Close without sending — card button now reads "Adjust quote"
 *   7. Card shows the booked total
 *
 * Run: pnpm --filter @workspace/book-my-cleaning run test:e2e:quote-redraft
 */

import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const artifactDir = path.dirname(fileURLToPath(new URL(".", import.meta.url)));
const APP_HOST = "localhost";
const APP_PORT = 4631;

const BOOKING_ID = 42;

/** Total after 3 h × $50/hr, no tax, no surcharges in the mock. */
const SAVED_TOTAL = 150;
const SAVED_TOTAL_TEXT = "$150.00";

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

function makeBooking({ priced }) {
  return {
    id: BOOKING_ID,
    status: "pending",
    service: "Regular cleaning",
    customerName: "Terry Test",
    customerPhone: "+17805550099",
    streetAddress: "123 Main St",
    city: "Edmonton",
    province: "AB",
    postCode: "T5J 0N4",
    scheduledFor: new Date(Date.now() + 7 * 86400_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    notes: null,
    crew: [],
    bedrooms: "3",
    bathrooms: "2",
    // Price fields — populated only after save
    quotedAmount: null,
    quoteHours: priced ? 3 : null,
    quoteCrewLabel: priced ? null : null,
    quoteHourlyRate: priced ? 50 : null,
    quoteFuelSurcharge: null,
    quoteDiscountAmount: null,
    quoteReferralSource: null,
    quoteDeposit: null,
    quoteTotals: priced
      ? {
          subtotal: SAVED_TOTAL,
          total: SAVED_TOTAL,
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
              quantity: 3,
              unitPrice: 50,
            },
          ],
        }
      : null,
    quoteSentAt: null,
    quoteSentTotals: null,
    quoteMessage: null,
    // Approval / Jobber
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

function makePreview({ priced }) {
  const message = priced
    ? `Hi Terry! We'd love to clean your home.\n\nYour quote is ${SAVED_TOTAL_TEXT} — let us know if you'd like to book!`
    : `Hi Terry! We'd love to clean your home. Let us know the budget that works for you.`;
  return {
    message,
    canSend: true,
    blockedReason: null,
    fromNumber: "+17805550000",
    totals: priced
      ? {
          subtotal: SAVED_TOTAL,
          total: SAVED_TOTAL,
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
              quantity: 3,
              unitPrice: 50,
            },
          ],
        }
      : null,
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

  // Pre-seed localStorage so one-time permission dialogs (LocationPermissionAsk,
  // CallAlertsAsk) don't open automatically and block the test clicks.
  // The email used in the /api/me mock drives the storage keys.
  const E2E_EMAIL = "e2e@test.example";
  await context.addInitScript((email) => {
    // Marks "has this device been asked about location sharing?" — prevents
    // LocationPermissionAsk from opening a Radix Dialog on first load.
    window.localStorage.setItem(`bmc:device-geo-asked:${email}`, "1");
    // Marks "has this browser been asked about call/notification alerts?" —
    // prevents CallAlertsAsk from showing its fixed card (key is not email-scoped).
    window.localStorage.setItem("bmc-call-alerts-asked", "yes");
  }, E2E_EMAIL);

  const page = await context.newPage();

  // Track mutations — the send-quote endpoint must NEVER be called.
  let sendQuoteCalled = false;
  // Flips to true when the PATCH is received; subsequent GET /bookings and
  // GET /quote-preview return the post-save shape.
  let priceSaved = false;

  // 3. Mock the backend API.
  //    Routes are evaluated LIFO, so we register in reverse priority order.
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
          // Rates the QuoteCalculator uses
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
        body: JSON.stringify(makeBooking({ priced: true })),
      });
    }

    // --- quote-preview ---
    if (pathname === `/api/bookings/${BOOKING_ID}/quote-preview`) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makePreview({ priced: priceSaved })),
      });
    }

    // --- PATCH booking (Save price) ---
    if (pathname === `/api/bookings/${BOOKING_ID}` && method === "PATCH") {
      priceSaved = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeBooking({ priced: true })),
      });
    }

    // --- GET bookings list ---
    if (pathname === "/api/bookings" || pathname.startsWith("/api/bookings?")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([makeBooking({ priced: priceSaved })]),
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

  // ── Assertion 1: card shows "Create quote" (no price yet) ───────────────
  const quotePriceBtn = page.locator(
    `[data-testid="button-quote-price-${BOOKING_ID}"]`,
  );
  let cardBtnText = "";
  try {
    await quotePriceBtn.waitFor({ timeout: 15_000 });
    cardBtnText = (await quotePriceBtn.innerText()).trim();
  } catch {
    const body = await page
      .evaluate(() => document.body?.innerText ?? "")
      .catch(() => "(unreachable)");
    log(`  Page text at failure:\n${body.slice(0, 800)}`);
  }
  check(
    cardBtnText === "Create quote",
    `card button reads "Create quote" before save (got "${cardBtnText}")`,
  );

  // ── Open the dialog ──────────────────────────────────────────────────────
  // Use force:true because AppLayout renders polling components (LiveCallAlert,
  // LiveCallBanner) that may briefly overlay the page. The button is confirmed
  // present and enabled from assertion 1 above.
  log("\nOpening Create quote dialog …");
  await quotePriceBtn.click({ force: true });

  // ── Assertion 2: no-price warning visible ───────────────────────────────
  const noPriceWarning = page.locator('[data-testid="text-no-price"]');
  let noPriceVisible = false;
  try {
    await noPriceWarning.waitFor({ timeout: 10_000 });
    noPriceVisible = await noPriceWarning.isVisible();
  } catch {
    // visible check failed
  }
  check(noPriceVisible, '"No price set yet" warning is visible on open');

  // ── Fill in the calculator: 3 hours × $50/hr ────────────────────────────
  log("\nFilling in calculator: 3 hours × $50/hr …");

  // Click the "3" hours chip (aria-pressed button, text "3", inside the dialog).
  // The chips render as <button type="button" aria-pressed="...">3</button>.
  const hoursChip = page
    .getByRole("button", { name: "3" })
    .filter({ hasNot: page.locator("[data-testid]") });
  // Fallback: find any button whose trimmed text is exactly "3".
  const allButtons = page.locator('button[type="button"][aria-pressed]');
  let hoursChipFound = false;
  try {
    // Use aria-pressed chip buttons; the "3" hours chip has aria-pressed="false"
    // initially (hours=null → wholeHours=0).
    const chip3 = page
      .locator('button[type="button"][aria-pressed]')
      .filter({ hasText: /^3$/ })
      .first();
    await chip3.waitFor({ timeout: 5_000 });
    await chip3.click();
    hoursChipFound = true;
  } catch {
    log("  Could not find hours chip via aria-pressed — trying by exact text");
    try {
      const btn = page.locator("button").filter({ hasText: /^3$/ }).first();
      await btn.waitFor({ timeout: 3_000 });
      await btn.click();
      hoursChipFound = true;
    } catch {
      // will fail later
    }
  }
  check(hoursChipFound, 'clicked the "3" hours chip');

  // Fill in the hourly rate input (aria-label="Hourly rate").
  const rateInput = page.locator('[aria-label="Hourly rate"]');
  let rateFilled = false;
  try {
    await rateInput.waitFor({ timeout: 5_000 });
    await rateInput.click({ clickCount: 3 });
    await rateInput.fill("50");
    rateFilled = true;
  } catch {
    log("  Could not find hourly rate input");
  }
  check(rateFilled, 'filled hourly rate input with "50"');

  // ── Assertion 3: Save price button is enabled ────────────────────────────
  const savePriceBtn = page.locator('[data-testid="button-save-price"]');
  let saveBtnEnabled = false;
  try {
    await savePriceBtn.waitFor({ timeout: 5_000 });
    saveBtnEnabled = await savePriceBtn.isEnabled();
  } catch {
    // not found
  }
  check(
    saveBtnEnabled,
    '"Save price" button is enabled after filling calculator',
  );

  // ── Click Save price ─────────────────────────────────────────────────────
  log("\nClicking Save price …");
  if (saveBtnEnabled) {
    await savePriceBtn.click();
  }

  // Wait for the "Price updated" toast (title text).
  let toastSeen = false;
  try {
    await page.waitForFunction(
      () =>
        document.body.innerText.includes("Price updated") ||
        document.body.innerText.includes("price updated"),
      { timeout: 10_000 },
    );
    toastSeen = true;
  } catch {
    // toast may have faded before we checked — the message redraft is the
    // authoritative signal; we'll check it next.
  }
  log(
    toastSeen
      ? "  (Price updated toast seen)"
      : "  (toast not seen — checking message)",
  );

  // ── Assertion 4: send-quote endpoint was NOT called ──────────────────────
  // Give a short settle time so any pending network calls flush.
  await page.waitForTimeout(500);
  check(
    !sendQuoteCalled,
    "send-quote endpoint was never called during Save price",
  );

  // ── Assertion 5: message contains the saved total ────────────────────────
  const messageArea = page.locator("#quote-message");
  let messageText = "";
  try {
    // The preview refetch after invalidation may take a moment.
    await page.waitForFunction(
      (total) => {
        const el = document.querySelector("#quote-message");
        return el && el.value && el.value.includes(total);
      },
      SAVED_TOTAL_TEXT,
      { timeout: 10_000 },
    );
    messageText = await messageArea.inputValue();
  } catch {
    try {
      messageText = await messageArea.inputValue();
    } catch {
      messageText = "(unreadable)";
    }
  }
  check(
    messageText.includes(SAVED_TOTAL_TEXT),
    `message textarea contains the saved total "${SAVED_TOTAL_TEXT}" (got "${messageText.slice(0, 120)}")`,
  );

  // ── Close without sending ────────────────────────────────────────────────
  log("\nClosing dialog without sending …");
  const cancelBtn = page.getByRole("button", { name: "Cancel" });
  try {
    await cancelBtn.waitFor({ timeout: 5_000 });
    await cancelBtn.click();
  } catch {
    // Try pressing Escape as fallback.
    await page.keyboard.press("Escape");
  }

  // Wait for the dialog to close (quote-price button re-appears on the card).
  await page.waitForTimeout(500);

  // ── Assertion 6: card button now reads "Adjust quote" ────────────────────
  let adjustText = "";
  try {
    await quotePriceBtn.waitFor({ timeout: 8_000 });
    adjustText = (await quotePriceBtn.innerText()).trim();
  } catch {
    adjustText = "(button not found after close)";
  }
  check(
    adjustText === "Adjust quote",
    `card button reads "Adjust quote" after save (got "${adjustText}")`,
  );

  // ── Assertion 7: booking card shows the price ────────────────────────────
  let cardShowsPrice = false;
  try {
    await page.waitForFunction(
      (total) => document.body.innerText.includes(total),
      SAVED_TOTAL_TEXT,
      { timeout: 8_000 },
    );
    cardShowsPrice = true;
  } catch {
    // price may appear in a slightly different format
    const bodyText = await page
      .evaluate(() => document.body.innerText)
      .catch(() => "");
    // Also accept $150 without cents.
    cardShowsPrice =
      bodyText.includes(SAVED_TOTAL_TEXT) || bodyText.includes("$150");
  }
  check(
    cardShowsPrice,
    `booking card shows total "${SAVED_TOTAL_TEXT}" after close`,
  );
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
log("\nAll quote-save-redraft checks passed.");
process.exit(0);
