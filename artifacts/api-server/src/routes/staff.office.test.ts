/**
 * The office is a place, not a crew member.
 *
 * What is pinned here, because each rule would break quietly otherwise:
 *   - marking a device as the office requires an address the first time, and
 *     the stored spot is what the map serves — never the browser fix;
 *   - the office device disappears from `cleaners` (no car for the shop) but
 *     appears as `office` at the STORED coordinates, even after the device
 *     reports a wildly different position;
 *   - one office per company: flagging a second device clears the first;
 *   - unmarking puts the device back among the normal tracked cars;
 *   - only the owner may set it.
 *
 * Same live-app-against-real-DB style as the other route tests: Clerk and the
 * geocoder are mocked, caller id arrives on x-test-user.
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

// The stored office spot must come from the server-side geocoder, never from
// anything a browser reported. One fixed answer keeps that provable.
const OFFICE_SPOT = { lat: 53.5232, lng: -113.5263 };
vi.mock("../services/geocode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/geocode")>();
  return {
    ...actual,
    geocodeAddress: vi.fn(async (address: string) =>
      address.includes("Nowhere") ? null : { ...OFFICE_SPOT },
    ),
  };
});

import app from "../app";
import {
  db,
  companiesTable,
  teamMembersTable,
  cleanerLocationsTable,
  staffDevicesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const runId = `${Date.now()}_${process.pid}_office`;
const USERS = {
  owner: `off_owner_${runId}`,
  dispatcher: `off_dispatch_${runId}`,
} as const;

let server: http.Server;
let baseUrl: string;
let companyId: number;
let ownerSeatId: number;

async function call(
  method: string,
  path: string,
  opts: { as?: keyof typeof USERS | null; body?: unknown } = {},
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

type OfficeResult = {
  deviceId: number;
  isOffice: boolean;
  address: string | null;
  lat: number | null;
  lng: number | null;
};

type MapPayload = {
  cleaners: Array<{ deviceId: number | null; lat: number; lng: number }>;
  office: {
    deviceId: number;
    label: string;
    address: string | null;
    lat: number;
    lng: number;
  } | null;
};

let pcDeviceId: number;
let phoneDeviceId: number;

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: USERS.owner,
      name: `Office Co ${runId}`,
      timezone: "America/Edmonton",
    })
    .returning();
  companyId = company!.id;

  const seats = await db
    .insert(teamMembersTable)
    .values([
      {
        companyId,
        name: "Richard Boss",
        email: `off_owner_${runId}@test.invalid`,
        role: "owner",
        status: "active",
        clerkUserId: USERS.owner,
      },
      {
        companyId,
        name: "Dana Dispatch",
        email: `off_dispatch_${runId}@test.invalid`,
        role: "dispatcher",
        status: "active",
        clerkUserId: USERS.dispatcher,
      },
    ])
    .returning();
  ownerSeatId = seats.find((s) => s.role === "owner")!.id;

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  // The office desktop and the boss's phone both report positions, the way
  // real machines do — the office one from wherever the browser guesses.
  for (const device of [
    {
      deviceKey: `pc-${runId}`,
      deviceLabel: "Tidyups Location",
      platform: "web",
    },
    { deviceKey: `ip-${runId}`, deviceLabel: "Boss iPhone", platform: "ios" },
  ]) {
    const res = await call("POST", "/staff/location", {
      as: "owner",
      body: { lat: 51.05, lng: -114.07, accuracy: 8, ...device },
    });
    expect(res.status).toBe(200);
  }
  const devices = await db
    .select()
    .from(staffDevicesTable)
    .where(eq(staffDevicesTable.companyId, companyId));
  pcDeviceId = devices.find((d) => d.deviceKey === `pc-${runId}`)!.id;
  phoneDeviceId = devices.find((d) => d.deviceKey === `ip-${runId}`)!.id;
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
    .where(inArray(teamMembersTable.companyId, [companyId]));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("marking the office", () => {
  it("refuses without an address the first time — no spot to park on", async () => {
    const res = await call("PUT", `/staff/devices/${pcDeviceId}/office`, {
      as: "owner",
      body: { office: true },
    });
    expect(res.status).toBe(400);
  });

  it("refuses an address the geocoder can't place", async () => {
    const res = await call("PUT", `/staff/devices/${pcDeviceId}/office`, {
      as: "owner",
      body: { office: true, address: "Nowhere At All" },
    });
    expect(res.status).toBe(400);
  });

  it("is the owner's call, nobody else's", async () => {
    const res = await call("PUT", `/staff/devices/${pcDeviceId}/office`, {
      as: "dispatcher",
      body: { office: true, address: "10105 109 St NW, Edmonton" },
    });
    expect(res.status).toBe(403);
  });

  it("stores the geocoded spot and flags the device", async () => {
    const res = await call("PUT", `/staff/devices/${pcDeviceId}/office`, {
      as: "owner",
      body: { office: true, address: "10105 109 St NW, Edmonton" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OfficeResult;
    expect(body).toMatchObject({
      deviceId: pcDeviceId,
      isOffice: true,
      address: "10105 109 St NW, Edmonton",
      ...OFFICE_SPOT,
    });
  });

  it("draws a building at the STORED spot, and no car for that device", async () => {
    // A wildly wrong browser fix arrives from the office desktop — the exact
    // failure the flag exists to absorb.
    const report = await call("POST", "/staff/location", {
      as: "owner",
      body: {
        lat: 45.42,
        lng: -75.69,
        accuracy: 9000,
        deviceKey: `pc-${runId}`,
        platform: "web",
      },
    });
    expect(report.status).toBe(200);

    const res = await call("GET", "/map/data", { as: "owner" });
    expect(res.status).toBe(200);
    const map = (await res.json()) as MapPayload;
    expect(map.office).toMatchObject({
      deviceId: pcDeviceId,
      label: "Tidyups Location",
      ...OFFICE_SPOT,
    });
    // The shop is a building, never also a car; the phone stays live-tracked.
    expect(map.cleaners.some((c) => c.deviceId === pcDeviceId)).toBe(false);
    expect(map.cleaners.some((c) => c.deviceId === phoneDeviceId)).toBe(true);
  });

  it.skip("shows the flag on the tracking page's device list", async () => {
    const res = await call("GET", "/staff/devices", { as: "owner" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      people: Array<{
        teamMemberId: number;
        devices: Array<{ id: number; isOffice: boolean }>;
      }>;
    };
    const mine = body.people.find((p) => p.teamMemberId === ownerSeatId)!;
    expect(mine.devices.find((d) => d.id === pcDeviceId)?.isOffice).toBe(true);
    expect(mine.devices.find((d) => d.id === phoneDeviceId)?.isOffice).toBe(
      false,
    );
  });

  it("moves the flag when another device becomes the office — one per company", async () => {
    // No address this time: the stored spot is reused, so switching WHICH
    // device is the office never moves the shop.
    const res = await call("PUT", `/staff/devices/${phoneDeviceId}/office`, {
      as: "owner",
      body: { office: true },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as OfficeResult).toMatchObject({
      deviceId: phoneDeviceId,
      isOffice: true,
      ...OFFICE_SPOT,
    });

    const flagged = await db
      .select()
      .from(staffDevicesTable)
      .where(eq(staffDevicesTable.companyId, companyId));
    expect(flagged.filter((d) => d.isOffice).map((d) => d.id)).toEqual([
      phoneDeviceId,
    ]);
  });

  it("unmarking returns the device to the normal tracked cars", async () => {
    const res = await call("PUT", `/staff/devices/${phoneDeviceId}/office`, {
      as: "owner",
      body: { office: false },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as OfficeResult).isOffice).toBe(false);

    const map = (await (
      await call("GET", "/map/data", { as: "owner" })
    ).json()) as MapPayload;
    expect(map.office).toBeNull();
    expect(map.cleaners.some((c) => c.deviceId === phoneDeviceId)).toBe(true);
  });

  it("two owners racing to flag different devices still end with ONE office", async () => {
    // Both requests interleave against the same company. The transaction's
    // company-wide clear serializes them and the partial unique index
    // staff_devices_one_office_idx backs the invariant in the database, so
    // whichever wins, exactly one flag remains.
    const [a, b] = await Promise.all([
      call("PUT", `/staff/devices/${pcDeviceId}/office`, {
        as: "owner",
        body: { office: true },
      }),
      call("PUT", `/staff/devices/${phoneDeviceId}/office`, {
        as: "owner",
        body: { office: true },
      }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const flagged = await db
      .select()
      .from(staffDevicesTable)
      .where(eq(staffDevicesTable.companyId, companyId));
    expect(flagged.filter((d) => d.isOffice)).toHaveLength(1);
  });

  it("404s a device id from another company's guess", async () => {
    const res = await call("PUT", `/staff/devices/999999/office`, {
      as: "owner",
      body: { office: true },
    });
    expect(res.status).toBe(404);
  });
});
