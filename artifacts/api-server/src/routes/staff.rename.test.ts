/**
 * Naming a device, and the two rules that make the name mean something.
 *
 *   1. A name that was GIVEN outlives the name a device calls itself. The
 *      owner renames the office PC to "Tidyups Location"; that PC posts its
 *      position thirty seconds later still calling itself "Boss PC". Without
 *      this rule the rename silently undoes itself and looks like a bug in
 *      saving, which is exactly the sort of thing nobody thinks to test.
 *   2. Only the owner names other people's devices. Everybody else names the
 *      one in their own hand — a cleaner renaming a colleague's phone on the
 *      map is not a thing that should be possible.
 *
 * Live app against the real database; Clerk is the only thing mocked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type http from "node:http";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

vi.mock("@clerk/express", () => ({
  getAuth: (req: { headers: Record<string, unknown> }) => ({
    userId: (req.headers["x-test-user"] as string | undefined) ?? null,
    sessionClaims: {},
  }),
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  clerkClient: {
    users: {
      getUser: async () => ({
        emailAddresses: [],
        firstName: "Test",
        lastName: "User",
      }),
    },
  },
}));

vi.mock("../middlewares/clerkProxyMiddleware", () => ({
  CLERK_PROXY_PATH: "/__clerk",
  clerkProxyMiddleware:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  getClerkProxyHost: () => null,
}));

import app from "../app";
import {
  db,
  companiesTable,
  teamMembersTable,
  cleanerLocationsTable,
  staffDevicesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

const runId = `${Date.now()}_${process.pid}_rename`;
const USERS = {
  owner: `ren_owner_${runId}`,
  cleaner: `ren_cleaner_${runId}`,
  other: `ren_other_${runId}`,
} as const;

let server: http.Server;
let baseUrl: string;
let companyId: number;

async function call(
  method: string,
  path: string,
  opts: { as?: keyof typeof USERS; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.as) headers["x-test-user"] = USERS[opts.as];
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  return fetch(`${baseUrl}/api${path}`, { method, headers, body });
}

/** Report a position as somebody, the way a real client would. */
async function report(
  as: keyof typeof USERS,
  deviceKey: string,
  deviceLabel: string,
): Promise<{ deviceId: number; deviceLabel: string }> {
  const res = await call("POST", "/staff/location", {
    as,
    body: {
      lat: 45.4,
      lng: -75.7,
      accuracy: 8,
      deviceKey,
      deviceLabel,
      platform: "web",
    },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { deviceId: number; deviceLabel: string };
}

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: USERS.owner,
      name: `Rename Co ${runId}`,
      timezone: "America/Toronto",
    })
    .returning();
  companyId = company!.id;

  await db.insert(teamMembersTable).values([
    {
      companyId,
      name: "Richard Boss",
      email: `ren_owner_${runId}@test.invalid`,
      role: "owner",
      status: "active",
      clerkUserId: USERS.owner,
    },
    {
      companyId,
      name: "Cara Cleaner",
      email: `ren_cleaner_${runId}@test.invalid`,
      role: "cleaner",
      status: "active",
      clerkUserId: USERS.cleaner,
      locationSharing: true,
    },
    {
      companyId,
      name: "Otto Other",
      email: `ren_other_${runId}@test.invalid`,
      role: "cleaner",
      status: "active",
      clerkUserId: USERS.other,
      locationSharing: true,
    },
  ]);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await db
    .delete(cleanerLocationsTable)
    .where(eq(cleanerLocationsTable.companyId, companyId));
  await db
    .delete(staffDevicesTable)
    .where(eq(staffDevicesTable.companyId, companyId));
  await db
    .delete(teamMembersTable)
    .where(eq(teamMembersTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("renaming a device", () => {
  it("keeps the given name when the device reports again", async () => {
    const first = await report("owner", `pc_${runId}`, "Boss PC");

    const renamed = await call("PATCH", `/staff/devices/${first.deviceId}`, {
      as: "owner",
      body: { label: "Tidyups Location" },
    });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { label: string }).label).toBe(
      "Tidyups Location",
    );

    // The very next report from that same PC still calls itself "Boss PC".
    const again = await report("owner", `pc_${runId}`, "Boss PC");
    expect(again.deviceId).toBe(first.deviceId);
    expect(again.deviceLabel).toBe("Tidyups Location");
  });

  it("lets the owner rename anybody's device", async () => {
    const hers = await report("cleaner", `phone_${runId}`, "iPhone");

    const res = await call("PATCH", `/staff/devices/${hers.deviceId}`, {
      as: "owner",
      body: { label: "Cara's work phone" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { label: string }).label).toBe(
      "Cara's work phone",
    );
  });

  it("lets somebody rename their own device", async () => {
    const mine = await report("other", `otto_${runId}`, "Android");

    const res = await call("PATCH", `/staff/devices/${mine.deviceId}`, {
      as: "other",
      body: { label: "Van tablet" },
    });
    expect(res.status).toBe(200);
  });

  it("refuses to let a cleaner rename someone else's device", async () => {
    const hers = await report("cleaner", `phone2_${runId}`, "Spare phone");

    const res = await call("PATCH", `/staff/devices/${hers.deviceId}`, {
      as: "other",
      body: { label: "Not mine" },
    });
    expect(res.status).toBe(403);

    const [row] = await db
      .select()
      .from(staffDevicesTable)
      .where(eq(staffDevicesTable.id, hers.deviceId));
    expect(row!.label).toBe("Spare phone");
  });

  it("rejects an empty name and unknown devices", async () => {
    const mine = await report("owner", `pc2_${runId}`, "Back office");

    const blank = await call("PATCH", `/staff/devices/${mine.deviceId}`, {
      as: "owner",
      body: { label: "   " },
    });
    expect(blank.status).toBe(400);

    const missing = await call("PATCH", "/staff/devices/99999999", {
      as: "owner",
      body: { label: "Ghost" },
    });
    expect(missing.status).toBe(404);
  });
});
