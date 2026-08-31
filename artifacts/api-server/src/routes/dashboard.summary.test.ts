/**
 * The dashboard summary must stay cheap as history accumulates.
 *
 * Booking tallies are computed as SQL aggregates bounded by the August 2026
 * history floor, and call metrics by a 90-day rolling window. These tests pin
 * both bounds: a Jobber-era booking and a six-month-old call are seeded next
 * to fresh rows, and neither may leak into the numbers the owner sees.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
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
      getUserList: async () => ({ data: [] }),
    },
    invitations: {
      createInvitation: async () => ({ id: "inv_test" }),
      revokeInvitation: async () => ({}),
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
  pool,
  companiesTable,
  bookingsTable,
  callsTable,
  activityTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

const runId = `${Date.now()}_${process.pid}`;
const OWNER = `dash_floor_owner_${runId}`;

const COMPANY_TZ = "America/Edmonton";
// Company-local midnight Aug 1, 2026 is 06:00Z (UTC-6). One booking sits a
// minute below the floor, one just above it, one far in the future.
const BELOW_FLOOR = new Date("2026-08-01T05:59:00Z");
const ABOVE_FLOOR = new Date("2026-08-01T06:01:00Z");
const FAR_FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

let server: http.Server;
let baseUrl: string;
let companyId: number;

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: OWNER,
      name: `Dash Floor Co ${runId}`,
      timezone: COMPANY_TZ,
    })
    .returning();
  companyId = company!.id;

  await db.insert(bookingsTable).values([
    {
      companyId,
      callId: null,
      customerName: "Jobber Era",
      customerPhone: "+15550001111",
      service: "Deep clean",
      scheduledFor: BELOW_FLOOR,
      status: "completed",
    },
    {
      companyId,
      callId: null,
      customerName: "Post Floor",
      customerPhone: "+15550002222",
      service: "Standard clean",
      scheduledFor: ABOVE_FLOOR,
      status: "completed",
    },
    {
      companyId,
      callId: null,
      customerName: "Upcoming",
      customerPhone: "+15550003333",
      service: "Standard clean",
      scheduledFor: FAR_FUTURE,
      status: "confirmed",
    },
  ]);

  // One answered call today, one missed call six months back. If the old
  // one leaked into the 90-day window, answeredRate would drop to 0.5.
  await db.insert(callsTable).values([
    {
      companyId,
      callerName: "Recent Caller",
      callerPhone: "+15550009999",
      status: "answered",
      startedAt: new Date(),
      durationSeconds: 60,
    },
    {
      companyId,
      callerName: "Old Caller",
      callerPhone: "+15550008888",
      status: "missed",
      startedAt: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000),
      durationSeconds: 0,
    },
  ]);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not determine test server port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server?.close();
  await db.delete(activityTable).where(eq(activityTable.companyId, companyId));
  await db.delete(bookingsTable).where(eq(bookingsTable.companyId, companyId));
  await db.delete(callsTable).where(eq(callsTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end();
});

describe("dashboard summary bounds", () => {
  it("counts only bookings from the history floor onward", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/summary`, {
      headers: { "x-test-user": OWNER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Two of the three seeded bookings are on/after the floor.
    expect(body.totalBookings).toBe(2);
    expect(body.upcomingBookings).toBe(1);
    expect(body.canceledBookings).toBe(0);
  });

  it("computes call metrics over the 90-day window only", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/summary`, {
      headers: { "x-test-user": OWNER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // The six-month-old missed call is outside the window: one call, answered.
    expect(body.callsToday).toBe(1);
    expect(body.answeredRate).toBe(1);
    expect(body.avgCallSeconds).toBe(60);
  });
});
