/**
 * The dashboard trusts /api/healthz to tell a paused database apart from any
 * other database failure. These tests pin the classification: the SQLSTATE
 * 28000 "endpoint has been disabled" signature reports database "paused",
 * every other failure reports "error", and a working database reports "ok" —
 * while the process-level `status` stays "ok" in all three cases so a load
 * balancer never recycles a healthy container over a sleeping database.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type http from "node:http";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: null, sessionClaims: {} }),
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  clerkClient: { users: { getUser: async () => ({ emailAddresses: [] }) } },
}));

vi.mock("../middlewares/clerkProxyMiddleware", () => ({
  CLERK_PROXY_PATH: "/__clerk",
  clerkProxyMiddleware:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  getClerkProxyHost: () => null,
}));

import app from "../app";
import { pool } from "@workspace/db";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await pool.end();
});

async function getHealth(): Promise<{
  status: number;
  body: { status: string; database: string };
}> {
  const res = await fetch(`${baseUrl}/api/healthz`);
  return {
    status: res.status,
    body: (await res.json()) as { status: string; database: string },
  };
}

describe("GET /api/healthz database classification", () => {
  it("reports ok when the database answers", async () => {
    const { status, body } = await getHealth();
    expect(status).toBe(200);
    expect(body).toEqual({ status: "ok", database: "ok" });
  });

  it("reports paused for the SQLSTATE 28000 disabled-endpoint signature", async () => {
    const pausedError = Object.assign(
      new Error(
        "The endpoint has been disabled. Enable it using the API and retry.",
      ),
      { code: "28000" },
    );
    vi.spyOn(pool, "query").mockImplementationOnce(
      () => Promise.reject(pausedError) as never,
    );

    const { status, body } = await getHealth();
    expect(status).toBe(200);
    expect(body).toEqual({ status: "ok", database: "paused" });
  });

  it("reports error (not paused) for other database failures", async () => {
    // Right code, wrong message: an ordinary auth failure must not be
    // misreported as a paused database — the owner would chase the wrong fix.
    const authError = Object.assign(
      new Error("password authentication failed for user"),
      { code: "28000" },
    );
    vi.spyOn(pool, "query").mockImplementationOnce(
      () => Promise.reject(authError) as never,
    );
    let result = await getHealth();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "ok", database: "error" });

    // Plain connection failure, no SQLSTATE at all.
    const connError = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    vi.spyOn(pool, "query").mockImplementationOnce(
      () => Promise.reject(connError) as never,
    );
    result = await getHealth();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "ok", database: "error" });
  });

  it("recovers to ok once the database answers again", async () => {
    const pausedError = Object.assign(
      new Error("The endpoint has been disabled"),
      { code: "28000" },
    );
    vi.spyOn(pool, "query").mockImplementationOnce(
      () => Promise.reject(pausedError) as never,
    );
    expect((await getHealth()).body.database).toBe("paused");
    // Spy was once-only: the next probe hits the real database.
    expect((await getHealth()).body.database).toBe("ok");
  });
});
