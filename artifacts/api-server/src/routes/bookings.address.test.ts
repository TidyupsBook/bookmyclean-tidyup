/**
 * Correcting a job's address from the dashboard.
 *
 * The point of these tests is the map pin. A booking carries coordinates that
 * were resolved from the OLD address; if an edit leaves them in place the map
 * and the "Get directions" link keep sending the crew to the previous house,
 * and nothing about the dashboard would show it. So a changed address must
 * un-pin the booking and hand it back to the geocode backfill, while an edit
 * that doesn't touch the address must leave a good pin alone.
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
  teamMembersTable,
  bookingsTable,
  bookingAssignmentsTable,
  activityTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const runId = `${Date.now()}_${process.pid}`;
const USERS = {
  owner: `addr_owner_${runId}`,
  cleaner: `addr_cleaner_${runId}`,
};

let server: http.Server;
let baseUrl: string;
let companyId: number;
let cleanerSeatId: number;

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

/** A job that has already been placed on the map. */
async function seedPinnedBooking(): Promise<number> {
  const [booking] = await db
    .insert(bookingsTable)
    .values({
      companyId,
      callId: null,
      customerName: "Pinned Customer",
      customerPhone: "+15550100001",
      customerAddress: "660 Cedar Court",
      addressCity: "Edmonton",
      addressProvince: "AB",
      service: "Deep clean",
      scheduledFor: new Date("2030-06-01T16:00:00Z"),
      status: "confirmed",
      lat: 53.5,
      lng: -113.5,
      geocodedAt: new Date("2030-05-30T00:00:00Z"),
    })
    .returning();
  return booking!.id;
}

async function pinOf(id: number) {
  const [row] = await db
    .select({
      lat: bookingsTable.lat,
      lng: bookingsTable.lng,
      geocodedAt: bookingsTable.geocodedAt,
      customerAddress: bookingsTable.customerAddress,
      addressCity: bookingsTable.addressCity,
    })
    .from(bookingsTable)
    .where(eq(bookingsTable.id, id))
    .limit(1);
  return row!;
}

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: USERS.owner,
      name: `Address Co ${runId}`,
      timezone: "America/Edmonton",
    })
    .returning();
  companyId = company!.id;

  const [cleaner] = await db
    .insert(teamMembersTable)
    .values({
      companyId,
      name: "Address Cleaner",
      email: `addr_cleaner_${runId}@test.invalid`,
      role: "cleaner",
      status: "active",
      clerkUserId: USERS.cleaner,
    })
    .returning();
  cleanerSeatId = cleaner!.id;

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
  if (companyId != null) {
    const rows = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.companyId, companyId));
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await db
        .delete(bookingAssignmentsTable)
        .where(inArray(bookingAssignmentsTable.bookingId, ids));
    }
    await db
      .delete(activityTable)
      .where(eq(activityTable.companyId, companyId));
    await db
      .delete(bookingsTable)
      .where(eq(bookingsTable.companyId, companyId));
    await db
      .delete(teamMembersTable)
      .where(eq(teamMembersTable.companyId, companyId));
    await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  }
  await pool.end();
});

describe("editing a booking's address", () => {
  it("drops the old map pin when the street changes", async () => {
    const id = await seedPinnedBooking();
    const res = await call("PATCH", `/bookings/${id}`, {
      as: "owner",
      body: { customerAddress: "5810 Mullen Place" },
    });
    expect(res.status).toBe(200);

    const after = await pinOf(id);
    expect(after.customerAddress).toBe("5810 Mullen Place");
    expect(after.lat).toBeNull();
    expect(after.lng).toBeNull();
    expect(after.geocodedAt).toBeNull();
  });

  it("drops the pin when only the city is corrected", async () => {
    const id = await seedPinnedBooking();
    const res = await call("PATCH", `/bookings/${id}`, {
      as: "owner",
      body: { addressCity: "St. Albert" },
    });
    expect(res.status).toBe(200);

    const after = await pinOf(id);
    expect(after.addressCity).toBe("St. Albert");
    expect(after.lat).toBeNull();
  });

  it("keeps the pin when the address is resubmitted unchanged", async () => {
    const id = await seedPinnedBooking();
    const res = await call("PATCH", `/bookings/${id}`, {
      as: "owner",
      body: {
        customerAddress: "660 Cedar Court",
        addressCity: "Edmonton",
        customerName: "Pinned Customer Renamed",
      },
    });
    expect(res.status).toBe(200);

    const after = await pinOf(id);
    expect(after.lat).toBe(53.5);
    expect(after.lng).toBe(-113.5);
    expect(after.geocodedAt).not.toBeNull();
  });

  it("keeps the pin when something unrelated is edited", async () => {
    const id = await seedPinnedBooking();
    const res = await call("PATCH", `/bookings/${id}`, {
      as: "owner",
      body: { status: "completed" },
    });
    expect(res.status).toBe(200);

    const after = await pinOf(id);
    expect(after.lat).toBe(53.5);
  });

  it("removes the address and its pin together", async () => {
    const id = await seedPinnedBooking();
    const res = await call("PATCH", `/bookings/${id}`, {
      as: "owner",
      body: {
        customerAddress: null,
        addressCity: null,
        addressProvince: null,
        addressPostal: null,
      },
    });
    expect(res.status).toBe(200);

    const after = await pinOf(id);
    expect(after.customerAddress).toBeNull();
    expect(after.addressCity).toBeNull();
    expect(after.lat).toBeNull();
    expect(after.geocodedAt).toBeNull();
  });

  it("refuses an address edit from a cleaner, even on their own job", async () => {
    const id = await seedPinnedBooking();
    await db.insert(bookingAssignmentsTable).values({
      bookingId: id,
      teamMemberId: cleanerSeatId,
    });

    const res = await call("PATCH", `/bookings/${id}`, {
      as: "cleaner",
      body: { customerAddress: "Somewhere else" },
    });
    expect(res.status).toBe(403);

    const after = await pinOf(id);
    expect(after.customerAddress).toBe("660 Cedar Court");
    expect(after.lat).toBe(53.5);
  });
});
