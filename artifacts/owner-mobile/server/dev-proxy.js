/**
 * Dev proxy in front of the Expo dev server.
 *
 * Why this exists: the workspace preview proxy forwards requests to this
 * artifact with the `/owner-mobile` path prefix intact, but the Expo dev
 * server only answers manifest/bundle requests at its root path. Expo Go on a
 * phone opening https://<dev-domain>/owner-mobile/ therefore used to get an
 * HTML 404 ("Cannot GET /owner-mobile/") and fail with a JSON parse error.
 *
 * This proxy:
 * - listens on $PORT (what both the main dev domain and the Expo dev domain
 *   route to),
 * - spawns the real `expo start` on a free internal port,
 * - strips the BASE_PATH prefix from incoming request paths (requests that
 *   already arrive at the root path — e.g. from the Expo dev domain — pass
 *   through unchanged),
 * - forwards WebSocket upgrades the same way so hot reload keeps working.
 *
 * Zero external dependencies — Node.js built-ins only (http, net,
 * child_process). The production static-build flow (server/serve.js) is
 * unrelated and untouched.
 */

const http = require("http");
const net = require("net");
const { spawn } = require("child_process");

const DEFAULT_BASE_PATH = "/owner-mobile";

/** Normalize a base path: no trailing slash, leading slash, "" if root. */
function normalizeBasePath(raw) {
  const trimmed = (raw || "").trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Rewrite a raw request URL (path + query string) by stripping the base-path
 * prefix. URLs that don't carry the prefix are returned unchanged so
 * root-path requests from the Expo dev domain keep working.
 */
function rewriteUrl(rawUrl, basePath) {
  const url = rawUrl || "/";
  if (!basePath) return url;
  if (url === basePath) return "/";
  if (url.startsWith(`${basePath}?`)) return `/${url.slice(basePath.length)}`;
  if (url.startsWith(`${basePath}/`)) return url.slice(basePath.length);
  return url;
}

/**
 * Create the pass-through HTTP(+WebSocket) proxy server. Exported for tests.
 */
function createProxyServer({ basePath, targetPort, targetHost = "127.0.0.1" }) {
  const server = http.createServer((req, res) => {
    const proxyReq = http.request(
      {
        host: targetHost,
        port: targetPort,
        method: req.method,
        path: rewriteUrl(req.url, basePath),
        headers: req.headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end("Expo dev server is not reachable yet. Retry in a moment.");
    });
    req.pipe(proxyReq);
  });

  // Forward WebSocket upgrades (Metro HMR) with the same prefix stripping.
  server.on("upgrade", (req, socket, head) => {
    const upstream = net.connect(targetPort, targetHost, () => {
      const lines = [`${req.method} ${rewriteUrl(req.url, basePath)} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  return server;
}

/** Ask the OS for a free port on localhost. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Poll until a TCP port accepts connections (or time out). */
function waitForPort(port, host, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, host);
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Timed out waiting for port ${port}`));
        } else {
          setTimeout(attempt, 300);
        }
      });
    };
    attempt();
  });
}

async function main() {
  const listenPort = parseInt(process.env.PORT || "3000", 10);
  const basePath = normalizeBasePath(
    process.env.BASE_PATH || DEFAULT_BASE_PATH,
  );
  const expoPort = await getFreePort();

  console.log(
    `[dev-proxy] starting expo on internal port ${expoPort}; proxy will listen on ${listenPort} (base path: "${basePath || "/"}")`,
  );

  const child = spawn(
    "pnpm",
    ["exec", "expo", "start", "--localhost", "--port", String(expoPort)],
    { stdio: "inherit", env: process.env },
  );
  child.on("exit", (code) => {
    console.log(`[dev-proxy] expo exited with code ${code}`);
    process.exit(code ?? 1);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }

  // Don't open $PORT until Expo is actually accepting connections, so the
  // workflow port check keeps meaning "the dev server is ready".
  await waitForPort(expoPort, "127.0.0.1", 180_000);

  const server = createProxyServer({ basePath, targetPort: expoPort });
  server.listen(listenPort, "0.0.0.0", () => {
    console.log(`[dev-proxy] listening on ${listenPort} → expo on ${expoPort}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[dev-proxy] fatal:", err);
    process.exit(1);
  });
}

module.exports = { createProxyServer, rewriteUrl, normalizeBasePath };
