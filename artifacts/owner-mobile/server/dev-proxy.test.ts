/**
 * Regression tests for the dev proxy that sits in front of the Expo dev
 * server. The bug this guards against: manifest requests arriving with the
 * `/owner-mobile` path prefix (from the main dev domain) used to fall through
 * to an HTML 404, which Expo Go on iOS failed to parse as JSON.
 *
 * The stub upstream below mimics the Expo dev server's observed behavior:
 * - GET / with an `expo-platform: ios|android` header → manifest JSON
 * - GET / without the header → HTML (Expo web)
 * - any other path → HTML 404 ("Cannot GET <path>")
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createProxyServer, rewriteUrl, normalizeBasePath } =
  require("./dev-proxy.js") as {
    createProxyServer: (opts: {
      basePath: string;
      targetPort: number;
      targetHost?: string;
    }) => http.Server;
    rewriteUrl: (rawUrl: string, basePath: string) => string;
    normalizeBasePath: (raw: string) => string;
  };

const BASE_PATH = "/owner-mobile";
const appRequire = createRequire(new URL("../package.json", import.meta.url));
const expoCliRequire = createRequire(
  appRequire.resolve("@expo/cli/package.json"),
);
const metroRequire = createRequire(
  expoCliRequire.resolve("metro/package.json"),
);
const imageSizePath = metroRequire.resolve("image-size");
const jxlPath = metroRequire.resolve("image-size/types/jxl");
const icnsPath = metroRequire.resolve("image-size/types/icns");
const heifPath = metroRequire.resolve("image-size/types/heif");

const MANIFEST = {
  id: "test-manifest-id",
  runtimeVersion: "exposdk:54.0.0",
  launchAsset: {
    key: "bundle",
    contentType: "application/javascript",
    url: "https://example.test/bundle.js",
  },
};

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("rewriteUrl", () => {
  it("strips the prefix with and without a trailing slash", () => {
    expect(rewriteUrl("/owner-mobile", BASE_PATH)).toBe("/");
    expect(rewriteUrl("/owner-mobile/", BASE_PATH)).toBe("/");
  });

  it("preserves sub-paths and query strings", () => {
    expect(rewriteUrl("/owner-mobile/hot?platform=ios", BASE_PATH)).toBe(
      "/hot?platform=ios",
    );
    expect(rewriteUrl("/owner-mobile?x=1", BASE_PATH)).toBe("/?x=1");
  });

  it("leaves root-path requests (Expo dev domain) untouched", () => {
    expect(rewriteUrl("/", BASE_PATH)).toBe("/");
    expect(rewriteUrl("/node_modules/foo.bundle?dev=true", BASE_PATH)).toBe(
      "/node_modules/foo.bundle?dev=true",
    );
  });

  it("does not mangle look-alike paths", () => {
    expect(rewriteUrl("/owner-mobile-extra/x", BASE_PATH)).toBe(
      "/owner-mobile-extra/x",
    );
  });

  it("normalizes base paths defensively", () => {
    expect(normalizeBasePath("/owner-mobile/")).toBe("/owner-mobile");
    expect(normalizeBasePath("owner-mobile")).toBe("/owner-mobile");
    expect(normalizeBasePath("/")).toBe("");
    expect(normalizeBasePath("")).toBe("");
  });
});

describe("dev proxy in front of a stub Expo dev server", () => {
  let upstream: http.Server;
  let proxy: http.Server;
  let proxyPort: number;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://localhost");
      const platform = req.headers["expo-platform"];
      if (url.pathname === "/") {
        if (platform === "ios" || platform === "android") {
          res.writeHead(200, {
            "content-type": "application/json",
            "expo-protocol-version": "1",
          });
          res.end(JSON.stringify(MANIFEST));
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<!DOCTYPE html><html><body>expo web</body></html>");
        return;
      }
      if (url.pathname === "/echo-path") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ path: req.url }));
        return;
      }
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!DOCTYPE html><html><body>Cannot GET ${url.pathname}</body></html>`,
      );
    });
    // Echo one WebSocket-style upgrade so we know HMR upgrades pass through.
    upstream.on("upgrade", (req, socket) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `X-Upstream-Path: ${req.url}\r\n\r\n`,
      );
      socket.end();
    });
    const upstreamPort = await listen(upstream);

    proxy = createProxyServer({
      basePath: BASE_PATH,
      targetPort: upstreamPort,
    });
    proxyPort = await listen(proxy);
  });

  afterAll(async () => {
    await close(proxy);
    await close(upstream);
  });

  const fetchProxy = (path: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${proxyPort}${path}`, { headers });

  it("serves manifest JSON on the prefixed path with a platform header", async () => {
    for (const path of ["/owner-mobile/", "/owner-mobile"]) {
      for (const platform of ["ios", "android"]) {
        const res = await fetchProxy(path, { "expo-platform": platform });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("application/json");
        const manifest = await res.json();
        expect(manifest.id).toBe(MANIFEST.id);
        expect(manifest.runtimeVersion).toBe(MANIFEST.runtimeVersion);
        expect(manifest.launchAsset.url).toBeTruthy();
      }
    }
  });

  it("serves manifest JSON on the root path with a platform header (Expo dev domain)", async () => {
    const res = await fetchProxy("/", { "expo-platform": "ios" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const manifest = await res.json();
    expect(manifest.id).toBe(MANIFEST.id);
  });

  it("serves HTML for plain browser requests on both paths", async () => {
    for (const path of ["/", "/owner-mobile/"]) {
      const res = await fetchProxy(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("expo web");
    }
  });

  it("strips the prefix from sub-paths and preserves query strings", async () => {
    const res = await fetchProxy(
      "/owner-mobile/echo-path?platform=ios&dev=true",
    );
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe("/echo-path?platform=ios&dev=true");
  });

  it("forwards WebSocket upgrades with the prefix stripped", async () => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxyPort, "127.0.0.1", () => {
        socket.write(
          "GET /owner-mobile/hot HTTP/1.1\r\n" +
            "Host: localhost\r\n" +
            "Connection: Upgrade\r\n" +
            "Upgrade: websocket\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
            "Sec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString("utf-8");
      });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
      setTimeout(() => resolve(data), 3000);
    });
    expect(response).toContain("101 Switching Protocols");
    expect(response).toContain("X-Upstream-Path: /hot");
  });

  it("returns 502 (not a hang) when the upstream is down", async () => {
    const deadProxy = createProxyServer({
      basePath: BASE_PATH,
      targetPort: 1, // nothing listens here
    });
    const deadPort = await listen(deadProxy);
    const res = await fetch(`http://127.0.0.1:${deadPort}/owner-mobile/`, {
      headers: { "expo-platform": "ios" },
    });
    expect(res.status).toBe(502);
    await close(deadProxy);
  });
});

describe("patched image-size used by Metro", () => {
  it("keeps Metro's file-path image sizing API", () => {
    const directory = mkdtempSync(join(tmpdir(), "image-size-metro-"));
    const pngPath = join(directory, "asset.png");
    const png = new Uint8Array(24);

    // PNG signature plus an IHDR chunk with a 2×3 image size.
    png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    png.set([73, 72, 68, 82], 12);
    new DataView(png.buffer).setUint32(16, 2, false);
    new DataView(png.buffer).setUint32(20, 3, false);
    writeFileSync(pngPath, png);

    try {
      const imageSize = metroRequire(imageSizePath).default as (
        path: string,
      ) => { width: number; height: number };
      expect(imageSize(pngPath)).toMatchObject({ width: 2, height: 3 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("terminates on malformed zero-length JXL, HEIF, and ICNS boxes", () => {
    const script = `
      const { JXL } = require(${JSON.stringify(jxlPath)});
      const { ICNS } = require(${JSON.stringify(icnsPath)});
      const { HEIF } = require(${JSON.stringify(heifPath)});
      const encoder = new TextEncoder();
      const box = (name, payload = new Uint8Array()) => {
        const output = new Uint8Array(8 + payload.length);
        new DataView(output.buffer).setUint32(0, output.length, false);
        output.set(encoder.encode(name), 4);
        output.set(payload, 8);
        return output;
      };
      const join = (...parts) => {
        const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
        let offset = 0;
        for (const part of parts) {
          output.set(part, offset);
          offset += part.length;
        }
        return output;
      };

      // A zero-length jxlp box used to leave JXL.extractPartialStreams at the
      // same offset forever.
      const signature = new Uint8Array(12);
      new DataView(signature.buffer).setUint32(0, 12, false);
      signature.set(encoder.encode("JXL "), 4);
      signature.set([0x0d, 0x0a, 0x87, 0x0a], 8);
      const ftypPayload = new Uint8Array(8);
      ftypPayload.set(encoder.encode("jxl "));
      const badJxlp = new Uint8Array(8);
      badJxlp.set(encoder.encode("jxlp"), 4);
      try {
        JXL.calculate(join(signature, box("ftyp", ftypPayload), badJxlp));
      } catch {
        // Rejecting malformed data is safe; looping is not.
      }

      // A zero-length box ahead of the HEIF ispe box used to make findBox
      // retry at the same offset forever.
      const uint32 = (value) => {
        const output = new Uint8Array(4);
        new DataView(output.buffer).setUint32(0, value, false);
        return output;
      };
      const heifFtypPayload = join(
        encoder.encode("avif"),
        new Uint8Array(4),
      );
      const zeroSizeJunk = new Uint8Array(8);
      zeroSizeJunk.set(encoder.encode("junk"), 4);
      const ispePayload = join(new Uint8Array(4), uint32(320), uint32(180));
      const ipco = box("ipco", join(zeroSizeJunk, box("ispe", ispePayload)));
      const iprp = box("iprp", ipco);
      const meta = box("meta", join(new Uint8Array(4), iprp));
      const dimensions = HEIF.calculate(
        join(box("ftyp", heifFtypPayload), meta),
      );
      if (dimensions.width !== 320 || dimensions.height !== 180) {
        throw new Error("HEIF dimensions were not parsed after a zero-size box");
      }

      // A zero-length ICNS entry similarly used to keep imageOffset unchanged.
      const badIcns = new Uint8Array(16);
      badIcns.set(encoder.encode("icns"), 0);
      new DataView(badIcns.buffer).setUint32(4, 16, false);
      badIcns.set(encoder.encode("ICON"), 8);
      try {
        ICNS.calculate(badIcns);
      } catch {
        // Rejecting malformed data is safe; looping is not.
      }
    `;
    const result = spawnSync(process.execPath, ["--eval", script], {
      encoding: "utf8",
      timeout: 1_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
