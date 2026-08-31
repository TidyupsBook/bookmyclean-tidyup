import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { canonicalHostRedirect } from "./canonicalHost";

const EXEMPT = [
  "/api/webhooks/quo",
  "/api/webhooks/jobber",
  "/api/stripe/webhook",
  "/api/company/jobber/callback",
  "/api/healthz",
] as const;

let server: http.Server;
let port: number;

beforeAll(async () => {
  const app = express();
  app.use(canonicalHostRedirect(EXEMPT));
  app.all(/.*/, (_req, res) => {
    res.status(200).json({ served: true });
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

/** Raw HTTP request so the Host header can be set to an arbitrary alias. */
function req(
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, method, path, headers },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            location: res.headers.location,
          }),
        );
      },
    );
    r.on("error", reject);
    r.end();
  });
}

const savedPin = process.env.PUBLIC_APP_URL;
const savedSignupHost = process.env.SIGNUP_HOST;

beforeEach(() => {
  process.env.PUBLIC_APP_URL = "https://bookmycleaning.net";
  delete process.env.SIGNUP_HOST;
});

afterEach(() => {
  if (savedPin === undefined) delete process.env.PUBLIC_APP_URL;
  else process.env.PUBLIC_APP_URL = savedPin;
  if (savedSignupHost === undefined) delete process.env.SIGNUP_HOST;
  else process.env.SIGNUP_HOST = savedSignupHost;
});

describe("canonicalHostRedirect", () => {
  it("redirects a page request on an alias host to the canonical domain", async () => {
    const res = await req("GET", "/dashboard", { Host: "bookcleaning.app" });
    expect(res.status).toBe(301);
    expect(res.location).toBe("https://bookmycleaning.net/dashboard");
  });

  it("preserves the path and query string", async () => {
    const res = await req("GET", "/setup?jobber=connected&x=1", {
      Host: "something.replit.app",
    });
    expect(res.status).toBe(301);
    expect(res.location).toBe(
      "https://bookmycleaning.net/setup?jobber=connected&x=1",
    );
  });

  it("honors X-Forwarded-Host from the deployment proxy", async () => {
    const res = await req("GET", "/", {
      Host: "internal:5000",
      "X-Forwarded-Host": "bookcleaning.app",
    });
    expect(res.status).toBe(301);
    expect(res.location).toBe("https://bookmycleaning.net/");
  });

  it("serves requests already on the canonical host", async () => {
    const res = await req("GET", "/dashboard", { Host: "bookmycleaning.net" });
    expect(res.status).toBe(200);
  });

  it("treats host comparison as case-insensitive", async () => {
    const res = await req("GET", "/", { Host: "BookMyCleaning.NET" });
    expect(res.status).toBe(200);
  });

  for (const path of EXEMPT) {
    it(`never bounces the exempt path ${path}`, async () => {
      const res = await req("GET", path, { Host: "old-host.replit.app" });
      expect(res.status).toBe(200);
    });
  }

  it("answers the deployment health probe directly on localhost", async () => {
    // The platform checker probes /api/healthz on a non-canonical host and
    // treats a 301 as failure (following it hairpins into the deployment
    // that is still starting). Bouncing this request restart-loops the app.
    const res = await req("GET", "/api/healthz", { Host: "localhost:8080" });
    expect(res.status).toBe(200);
  });

  it("does not redirect POSTs even on an alias host", async () => {
    const res = await req("POST", "/api/anything", {
      Host: "bookcleaning.app",
    });
    expect(res.status).toBe(200);
  });

  it("does nothing when no canonical URL is pinned (development)", async () => {
    delete process.env.PUBLIC_APP_URL;
    const res = await req("GET", "/dashboard", {
      Host: "whatever.replit.dev",
    });
    expect(res.status).toBe(200);
  });

  it("leaves the designated signup host alone — it is its own front door", async () => {
    process.env.SIGNUP_HOST = "bookcleaning.app";
    const res = await req("GET", "/onboarding", { Host: "bookcleaning.app" });
    expect(res.status).toBe(200);
  });

  it("matches a signup host pasted as a full URL, case-insensitively", async () => {
    process.env.SIGNUP_HOST = "https://BookCleaning.APP/";
    const res = await req("GET", "/", { Host: "bookcleaning.app" });
    expect(res.status).toBe(200);
  });

  it("treats the www sibling of the signup host as the same front door", async () => {
    process.env.SIGNUP_HOST = "cleaninghub.io";
    const res = await req("GET", "/onboarding", {
      Host: "www.cleaninghub.io",
    });
    expect(res.status).toBe(200);
  });

  it("treats the bare domain as the same door when www was named", async () => {
    process.env.SIGNUP_HOST = "www.cleaninghub.io";
    const res = await req("GET", "/onboarding", { Host: "cleaninghub.io" });
    expect(res.status).toBe(200);
  });

  it("honors several signup hosts listed together", async () => {
    process.env.SIGNUP_HOST = "cleaninghub.io, bookcleaning.app";
    expect((await req("GET", "/", { Host: "cleaninghub.io" })).status).toBe(
      200,
    );
    expect((await req("GET", "/", { Host: "bookcleaning.app" })).status).toBe(
      200,
    );
  });

  it("never lets the canonical site become a signup door, however spelled", async () => {
    // Naming the canonical site — bare, www, or with an explicit port — must
    // not quietly turn the address that is meant to stay shut into the open
    // one. The www sibling is the same door as the bare host everywhere else
    // here, so it cannot be an exception in the one place that matters.
    for (const spelling of [
      "bookmycleaning.net",
      "www.bookmycleaning.net",
      "https://bookmycleaning.net:443",
    ]) {
      process.env.SIGNUP_HOST = spelling;
      const sibling = await req("GET", "/dashboard", {
        Host: "www.bookmycleaning.net",
      });
      expect(sibling.status, spelling).toBe(301);
      expect(sibling.location).toBe("https://bookmycleaning.net/dashboard");
    }
  });

  it("still bounces other aliases while a signup host is set", async () => {
    process.env.SIGNUP_HOST = "bookcleaning.app";
    const res = await req("GET", "/dashboard", {
      Host: "something.replit.app",
    });
    expect(res.status).toBe(301);
    expect(res.location).toBe("https://bookmycleaning.net/dashboard");
  });

  it("does not exempt lookalike prefixes of exempt paths", async () => {
    const res = await req("GET", "/api/webhooks/quoted", {
      Host: "bookcleaning.app",
    });
    expect(res.status).toBe(301);
  });
});
