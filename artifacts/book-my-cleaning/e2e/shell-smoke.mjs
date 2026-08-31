/**
 * Browser-level check that the booking site never shows an empty page — even
 * in the environment where the blank-page outage actually happened: a real
 * Chromium, with the site inside a cross-site iframe (like the Replit preview
 * pane) and third-party cookies/storage blocked, so the Clerk auth handshake
 * can never complete.
 *
 * The jsdom test (src/lib/appShell.test.ts) already pins the DOM contract of
 * the static-shell handoff. This script closes the loop at the browser level:
 *
 *   1. Dev server, iframed cross-site, third-party storage blocked:
 *      the visible page must never be empty at any sampled moment.
 *   2. Production build (no dev error overlay), same conditions.
 *   3. Production build with the JS bundle deliberately 404ing:
 *      the marketing shell must stay up and the failure banner must appear.
 *
 * Run with: pnpm --filter @workspace/book-my-cleaning run test:e2e
 * Requires REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE (present in this workspace).
 */

import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const artifactDir = path.dirname(fileURLToPath(new URL(".", import.meta.url)));
const distDir = path.join(artifactDir, "dist", "public");

// Distinct hosts so the iframe is genuinely cross-SITE (ports alone would be
// same-site on localhost, and third-party blocking is keyed on the site).
const APP_HOST = "localhost";
const HARNESS_HOST = "127.0.0.1";

const DEV_PORT = 4611;
const PROD_PORT = 4612;
const BROKEN_PORT = 4613;
const HARNESS_PORT = 4614;

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
// Servers
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/** Static server over dist/public with SPA fallback. `blockScripts` makes
 *  every .js asset 404 — the "deployed bundle is gone/unreachable" case. */
function serveDist(port, { blockScripts = false } = {}) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (blockScripts && urlPath.endsWith(".js")) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    let filePath = path.join(distDir, urlPath);
    if (
      !filePath.startsWith(distDir) ||
      !existsSync(filePath) ||
      statSync(filePath).isDirectory()
    ) {
      filePath = path.join(distDir, "index.html");
    }
    res.writeHead(200, {
      "content-type":
        MIME[path.extname(filePath)] ?? "application/octet-stream",
    });
    createReadStream(filePath).pipe(res);
  });
  return listen(server, port);
}

/** The "preview pane": a page on a different site that iframes the app. */
function serveHarness(port) {
  const server = http.createServer((req, res) => {
    const target = new URL(req.url, "http://x").searchParams.get("target");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<html><head><title>preview harness</title></head>
<body style="margin:0">
<iframe id="preview" src="${target}" style="border:0;width:100vw;height:100vh"></iframe>
</body></html>`);
  });
  return listen(server, port);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, () => {
      cleanups.push(() => new Promise((r) => server.close(r)));
      resolve(server);
    });
  });
}

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
            ? reject(new Error(`timed out waiting for ${url}`))
            : setTimeout(attempt, 500);
        });
    };
    attempt();
  });
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    );
  });
}

// ---------------------------------------------------------------------------
// Assertions inside the iframed app
// ---------------------------------------------------------------------------

function appFrame(page, port) {
  return page.frames().find((f) => f.url().includes(`${APP_HOST}:${port}`));
}

/**
 * Load the app inside the cross-site iframe and sample its visible text
 * repeatedly. Once the framed document has a body, every sample must contain
 * readable text — this is the exact regression: a shell dismissed before
 * anything replaced it.
 */
async function assertNeverBlank(page, port, label, sampleForMs = 8_000) {
  await page.goto(
    `http://${HARNESS_HOST}:${HARNESS_PORT}/?target=${encodeURIComponent(
      `http://${APP_HOST}:${port}/`,
    )}`,
    { waitUntil: "commit" },
  );

  let samples = 0;
  let blankSamples = 0;
  const deadline = Date.now() + sampleForMs;
  while (Date.now() < deadline) {
    const frame = appFrame(page, port);
    if (frame) {
      const text = await frame
        .evaluate(() => document.body?.innerText ?? "")
        .catch(() => null); // frame mid-navigation: skip this sample
      if (text !== null && text !== "") {
        samples += 1;
        if (!text.trim()) blankSamples += 1;
      } else if (text === "") {
        // A body exists but has zero rendered text — only blank if the
        // document has finished enough to have a body at all.
        const hasBody = await frame
          .evaluate(() => !!document.body)
          .catch(() => false);
        if (hasBody) {
          samples += 1;
          blankSamples += 1;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  check(
    samples > 10,
    `${label}: page produced content to sample (${samples} samples)`,
  );
  check(
    blankSamples === 0,
    `${label}: visible page was never empty (${blankSamples}/${samples} blank samples)`,
  );

  const frame = appFrame(page, port);
  const finalText = frame
    ? await frame.evaluate(() => document.body.innerText)
    : "";
  const readable =
    /Sparkling spaces/i.test(finalText) || // marketing shell
    /didn't load/i.test(finalText) || // failure banner
    finalText.trim().length > 40; // the app (or a loading state) rendered
  check(
    readable,
    `${label}: final page shows app, shell, or a readable message`,
  );
  return frame;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const executablePath = process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE;
if (!executablePath) {
  console.error(
    "REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE is not set; cannot run browser check.",
  );
  process.exit(1);
}

try {
  // 1. Production build (vite.config needs PORT/BASE_PATH even to build).
  log("Building production bundle…");
  await run("pnpm", ["exec", "vite", "build", "--config", "vite.config.ts"], {
    cwd: artifactDir,
    env: {
      ...process.env,
      PORT: String(PROD_PORT),
      BASE_PATH: "/",
      NODE_ENV: "production",
    },
  });

  // 2. Servers: prod, prod-with-404-bundle, dev, and the iframing harness.
  await serveDist(PROD_PORT);
  await serveDist(BROKEN_PORT, { blockScripts: true });
  await serveHarness(HARNESS_PORT);

  log("Starting dev server…");
  const dev = spawn(
    "pnpm",
    ["exec", "vite", "--config", "vite.config.ts", "--host", "0.0.0.0"],
    {
      cwd: artifactDir,
      env: { ...process.env, PORT: String(DEV_PORT), BASE_PATH: "/" },
      stdio: "ignore",
    },
  );
  cleanups.push(() => dev.kill("SIGTERM"));
  await waitForHttp(`http://${APP_HOST}:${DEV_PORT}/`);

  // 3. Real Chromium with third-party cookies/storage blocked, like a browser
  //    that partitions or blocks storage for iframed sites.
  const browser = await chromium.launch({
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--block-third-party-cookies",
      "--test-third-party-cookie-phaseout",
    ],
  });
  cleanups.push(() => browser.close());
  const context = await browser.newContext();

  log("\nDev server, iframed cross-site, third-party storage blocked:");
  await assertNeverBlank(await context.newPage(), DEV_PORT, "dev");

  log("\nProduction build, iframed cross-site, third-party storage blocked:");
  await assertNeverBlank(await context.newPage(), PROD_PORT, "prod");

  log("\nProduction build with the JS bundle 404ing:");
  const page = await context.newPage();
  const frame = await assertNeverBlank(
    page,
    BROKEN_PORT,
    "broken bundle",
    6_000,
  );
  if (frame) {
    const shellDisplay = await frame.evaluate(() => {
      const shell = document.getElementById("static-shell");
      return shell ? getComputedStyle(shell).display : "missing";
    });
    check(
      shellDisplay === "block",
      "broken bundle: marketing shell still on screen",
    );
    const banner = await frame.evaluate(
      () => document.getElementById("startup-error")?.innerText ?? "",
    );
    check(
      banner.includes("The booking app didn't load."),
      "broken bundle: failure banner is shown",
    );
    check(
      /failed to download/i.test(banner),
      "broken bundle: banner names the download failure",
    );
    check(
      banner.includes("(780) 718-5092"),
      "broken bundle: banner offers the phone fallback",
    );
  } else {
    check(false, "broken bundle: app frame reachable");
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
log("\nAll browser-level shell checks passed.");
process.exit(0);
