/**
 * Captures App Store / Play Store screenshots of the owner mobile app.
 *
 * Runs the real app (Expo web build served by the owner-mobile workflow)
 * signed in as the demo company seeded by
 * artifacts/api-server/scripts/seed-store-demo.ts, and screenshots each
 * screen at exact store pixel sizes:
 *   - Apple 6.7"/6.9" phones: 430x932 viewport at 3x -> 1290x2796
 *   - Google Play phones:     360x640 viewport at 3x -> 1080x1920
 *     (Play rejects images with aspect ratio over 2:1, so the Apple
 *     size cannot be reused.)
 *
 * Credentials come from /tmp/demo-creds.json (never committed). Re-run the
 * seed script first so "today's jobs" and live crew pins are fresh.
 *
 * Run from repo root:
 *   node artifacts/owner-mobile/scripts/store-screenshots.mjs
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

// playwright-core is a dependency of the web app's e2e setup; reuse it.
const require = createRequire(
  path.resolve("artifacts/book-my-cleaning/package.json"),
);
const { chromium } = require("playwright-core");

const BASE = `https://${process.env.REPLIT_EXPO_DEV_DOMAIN}`;
const creds = JSON.parse(readFileSync("/tmp/demo-creds.json", "utf8"));

const SIZES = [
  { name: "apple", width: 430, height: 932 }, // x3 = 1290x2796
  { name: "google", width: 360, height: 640 }, // x3 = 1080x1920
];

// Ids of seeded rows (call transcript, chat thread, booking) change on
// every re-seed; the seed script writes them here.
const ids = JSON.parse(readFileSync("/tmp/demo-seed-ids.json", "utf8"));

// The map tab is skipped: on web it renders a "draws on your phone"
// fallback, not the real map, so it would misrepresent the app.
const SCREENS = [
  { slug: "01-jobs", path: "/", waitText: "Margaret Wilson" },
  { slug: "02-calls", path: "/calls", waitText: "Devon Clarke" },
  {
    slug: "03-call-transcript",
    path: `/call/${ids.margaretCallId}`,
    waitText: "daughter",
  },
  { slug: "04-messages", path: "/messages", waitText: "Linda Tran" },
  { slug: "05-activity", path: "/activity", waitText: "Margaret Wilson" },
  { slug: "06-leads", path: "/leads", waitText: "Nina" },
  { slug: "07-team", path: "/team", waitText: "Sofia Reyes" },
  {
    slug: "08-team-chat",
    path: `/team-chat/${ids.crewChatId}`,
    waitText: "Whitemud",
  },
  {
    slug: "09-booking",
    path: `/booking/${ids.margaretBookingId}`,
    waitText: "Deep Clean",
  },
];

/**
 * Lands on the Jobs screen, signing in only if the restored session isn't
 * good — Clerk dev instances rate-limit sign-ins, so reuse beats re-auth.
 */
async function ensureSignedIn(page) {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  // Expo dev bundler can be slow on first load.
  const first = await Promise.race([
    page
      .waitForSelector("text=Margaret Wilson", { timeout: 180_000 })
      .then(() => "in")
      .catch(() => null),
    page
      .waitForSelector('[data-testid="email-input"]', { timeout: 180_000 })
      .then(() => "form")
      .catch(() => null),
  ]);
  if (first === "in") return;
  if (first !== "form") throw new Error("app never reached sign-in or data");

  await page.fill('[data-testid="email-input"]', creds.email);
  await page.fill('[data-testid="password-input"]', creds.password);
  await page.click('[data-testid="sign-in-button"]');

  // Either the tabs load, or Clerk asks for a verification code
  // (+clerk_test addresses on a dev instance always accept 424242).
  const outcome = await Promise.race([
    page
      .waitForSelector('[data-testid="code-input"]', { timeout: 60_000 })
      .then(() => "code")
      .catch(() => null),
    page
      .waitForSelector("text=Margaret Wilson", { timeout: 60_000 })
      .then(() => "in")
      .catch(() => null),
  ]);
  if (outcome === "code") {
    await page.fill('[data-testid="code-input"]', "424242");
    await page.click('[data-testid="verify-button"]');
  }
  try {
    await page.waitForSelector("text=Margaret Wilson", { timeout: 90_000 });
  } catch (err) {
    const text = await page
      .evaluate(() => document.body.innerText)
      .catch(() => "");
    console.error("sign-in stalled; screen shows:\n" + text.slice(0, 500));
    throw err;
  }
}

async function captureSet(browser, size, storageState) {
  const ctx = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 3,
    storageState,
  });
  const page = await ctx.newPage();
  await ensureSignedIn(page);

  const dir = path.resolve("screenshots/store", size.name);
  mkdirSync(dir, { recursive: true });

  for (const screen of SCREENS) {
    await page.goto(BASE + screen.path, { waitUntil: "domcontentloaded" });
    if (screen.waitText) {
      // On a hard reload the first API call can race Clerk's token and the
      // screen shows a "Try again" error state — click through it.
      let ok = false;
      for (let attempt = 0; attempt < 5 && !ok; attempt++) {
        ok = await page
          .waitForSelector(`text=${screen.waitText}`, { timeout: 25_000 })
          .then(() => true)
          .catch(() => false);
        if (!ok) {
          const retry = page.locator("text=Try again").first();
          if (await retry.isVisible().catch(() => false)) await retry.click();
        }
      }
      if (!ok)
        throw new Error(`never saw "${screen.waitText}" on ${screen.path}`);
    }
    // Let maps, avatars and animations settle.
    await page.waitForTimeout(screen.path === "/map" ? 8_000 : 2_500);
    await page.screenshot({ path: path.join(dir, `${screen.slug}.png`) });
    console.log(`${size.name}/${screen.slug}.png`);
  }

  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

const browser = await chromium.launch({
  executablePath: process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE,
});
// Reuse the session across runs — Clerk dev instances rate-limit sign-ins.
const STATE_FILE = "/tmp/demo-state.json";
let state = existsSync(STATE_FILE) ? STATE_FILE : undefined;
for (const size of SIZES) {
  state = await captureSet(browser, size, state);
  writeFileSync(STATE_FILE, JSON.stringify(state));
}
await browser.close();
console.log("done");
