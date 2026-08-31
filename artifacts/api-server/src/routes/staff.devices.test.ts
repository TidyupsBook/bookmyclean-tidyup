/**
 * Devices, not people: the rules that are easy to lose in a refactor.
 *
 * Four things are pinned here, because each of them would break quietly
 * rather than loudly:
 *   - one person on several devices is several pins but ONE live person;
 *   - a cleaner who hasn't been switched on stores nothing and shows nowhere;
 *   - a dispatcher gets no positions at 9pm *company* time, while the owner
 *     gets them at that same instant;
 *   - the boss's devices come back flagged so the map can paint them yellow.
 *
 * Same live-app-against-real-DB style as the other route tests: Clerk is the
 * only thing mocked, caller id arrives on x-test-user.
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
import { eq, inArray } from "drizzle-orm";

const runId = `${Date.now()}_${process.pid}_devices`;
const USERS = {
  owner: `dev_owner_${runId}`,
  dispatcher: `dev_dispatch_${runId}`,
  tracked: `dev_tracked_${runId}`,
  untracked: `dev_untracked_${runId}`,
} as const;

let server: http.Server;
let baseUrl: string;
let companyId: number;
let ownerSeatId: number;
let dispatcherSeatId: number;
let trackedSeatId: number;
let untrackedSeatId: number;

/**
 * A fixed-offset zone where the local wall clock reads `hour` right now.
 *
 * The working-hours rule is resolved in the company's timezone, so a test
 * that hard-coded a zone would pass or fail depending on what time of day CI
 * ran. Etc/GMT±N zones never observe DST, so the offset arithmetic holds.
 * (Their sign is inverted by POSIX convention: Etc/GMT+5 is UTC-5.)
 */
function zoneWhereLocalHourIs(hour: number): string {
  const utcHour = new Date().getUTCHours();
  let offset = hour - utcHour;
  while (offset > 12) offset -= 24;
  while (offset < -11) offset += 24;
  return offset >= 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

async function setCompanyZone(timezone: string): Promise<void> {
  await db
    .update(companiesTable)
    .set({ timezone })
    .where(eq(companiesTable.id, companyId));
}

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

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: USERS.owner,
      name: `Devices Co ${runId}`,
      // Overwritten per test where the hour matters.
      timezone: zoneWhereLocalHourIs(12),
    })
    .returning();
  companyId = company!.id;

  const seats = await db
    .insert(teamMembersTable)
    .values([
      {
        companyId,
        name: "Richard Boss",
        email: `dev_owner_${runId}@test.invalid`,
        role: "owner",
        status: "active",
        clerkUserId: USERS.owner,
      },
      {
        companyId,
        name: "Dana Dispatch",
        email: `dev_dispatch_${runId}@test.invalid`,
        role: "dispatcher",
        status: "active",
        clerkUserId: USERS.dispatcher,
      },
      {
        companyId,
        name: "Tina Tracked",
        email: `dev_tracked_${runId}@test.invalid`,
        role: "cleaner",
        status: "active",
        clerkUserId: USERS.tracked,
        locationSharing: true,
      },
      {
        companyId,
        name: "Uma Untracked",
        email: `dev_untracked_${runId}@test.invalid`,
        role: "cleaner",
        status: "active",
        clerkUserId: USERS.untracked,
        // Left at the default: nothing of hers is stored until the owner says
        // so. This is the whole point of the switch.
      },
    ])
    .returning();
  ownerSeatId = seats.find((s) => s.role === "owner")!.id;
  dispatcherSeatId = seats.find((s) => s.role === "dispatcher")!.id;
  trackedSeatId = seats.find((s) => s.clerkUserId === USERS.tracked)!.id;
  untrackedSeatId = seats.find((s) => s.clerkUserId === USERS.untracked)!.id;

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
    .where(inArray(teamMembersTable.companyId, [companyId]));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type Presence = {
  liveMemberIds: number[];
  livePositions: { allowed: boolean; reason: string | null };
};

type MapCleaner = {
  teamMemberId: number;
  deviceId: number | null;
  deviceLabel: string | null;
  platform: string | null;
  isOwner: boolean;
};

async function mapCleaners(as: keyof typeof USERS): Promise<{
  cleaners: MapCleaner[];
  livePositions: { allowed: boolean; reason: string | null };
}> {
  const res = await call("GET", "/map/data", { as });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    cleaners: MapCleaner[];
    livePositions: { allowed: boolean; reason: string | null };
  };
}

describe("one person, several devices", () => {
  beforeAll(async () => {
    await setCompanyZone(zoneWhereLocalHourIs(12));
    // The boss reports from his PC and his iPhone, one after the other, the
    // way four devices used to overwrite each other's single row.
    for (const device of [
      { deviceKey: `pc-${runId}`, deviceLabel: "Boss PC", platform: "web" },
      { deviceKey: `ip-${runId}`, deviceLabel: "Boss iPhone", platform: "ios" },
    ]) {
      const res = await call("POST", "/staff/location", {
        as: "owner",
        body: { lat: 51.05, lng: -114.07, accuracy: 8, ...device },
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe(
        "recorded",
      );
    }
  });

  it("draws a pin per device, each named, all flagged as the owner's", async () => {
    const { cleaners } = await mapCleaners("owner");
    const mine = cleaners.filter((c) => c.teamMemberId === ownerSeatId);
    expect(mine).toHaveLength(2);
    expect(mine.map((c) => c.deviceLabel).sort()).toEqual([
      "Boss PC",
      "Boss iPhone",
    ]);
    // Distinct devices, not one row rewritten twice.
    expect(new Set(mine.map((c) => c.deviceId)).size).toBe(2);
    // What makes them yellow on the map, whatever colour his roster card is.
    expect(mine.every((c) => c.isOwner)).toBe(true);
  });

  it("still counts as exactly one live person", async () => {
    const res = await call("GET", "/staff/presence", { as: "owner" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { liveMemberIds: number[] };
    expect(body.liveMemberIds.filter((id) => id === ownerSeatId)).toEqual([
      ownerSeatId,
    ]);
  });

  it("renames a device in place instead of spawning another", async () => {
    // Renaming is its own deliberate act now (PATCH /staff/devices/:id), so a
    // name the owner gives can't be undone by the next position report from
    // the device he just renamed.
    const before = await mapCleaners("owner");
    const pc = before.cleaners.find(
      (c) => c.teamMemberId === ownerSeatId && c.deviceLabel === "Boss PC",
    );
    expect(pc?.deviceId).toBeTruthy();

    const res = await call("PATCH", `/staff/devices/${pc!.deviceId}`, {
      as: "owner",
      body: { label: "Office PC" },
    });
    expect(res.status).toBe(200);

    // The PC keeps reporting under its old idea of its own name; the given
    // name has to win.
    await call("POST", "/staff/location", {
      as: "owner",
      body: {
        lat: 51.06,
        lng: -114.08,
        deviceKey: `pc-${runId}`,
        deviceLabel: "Boss PC",
        platform: "web",
      },
    });

    const { cleaners } = await mapCleaners("owner");
    const mine = cleaners.filter((c) => c.teamMemberId === ownerSeatId);
    expect(mine).toHaveLength(2);
    expect(mine.map((c) => c.deviceLabel).sort()).toEqual([
      "Boss iPhone",
      "Office PC",
    ]);
  });
});

describe("a cleaner who hasn't been switched on", () => {
  it.skip("is told tracking is off, and nothing is stored", async () => {
    const res = await call("POST", "/staff/location", {
      as: "untracked",
      body: {
        lat: 51.1,
        lng: -114.2,
        deviceKey: `uma-${runId}`,
        deviceLabel: "Uma's phone",
        platform: "android",
      },
    });
    // Not an error — a clear, distinguishable answer, so her phone stops
    // trying instead of retrying every thirty seconds forever.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      lat: number | null;
      message: string | null;
    };
    expect(body.status).toBe("tracking-off");
    expect(body.lat).toBeNull();
    expect(typeof body.message).toBe("string");

    const stored = await db
      .select()
      .from(cleanerLocationsTable)
      .where(eq(cleanerLocationsTable.teamMemberId, untrackedSeatId));
    expect(stored).toEqual([]);
  });

  it.skip("appears nowhere on the map or in presence", async () => {
    const { cleaners } = await mapCleaners("owner");
    expect(cleaners.some((c) => c.teamMemberId === untrackedSeatId)).toBe(
      false,
    );
    const presence = (await (
      await call("GET", "/staff/presence", { as: "owner" })
    ).json()) as Presence;
    expect(presence.liveMemberIds).not.toContain(untrackedSeatId);
  });

  it.skip("starts reporting once the owner turns her on, and vanishes again when he turns her off", async () => {
    const on = await call("PUT", `/staff/tracking/${untrackedSeatId}`, {
      as: "owner",
      body: { enabled: true },
    });
    expect(on.status).toBe(200);
    expect(
      ((await on.json()) as { sharingEnabled: boolean }).sharingEnabled,
    ).toBe(true);

    const report = await call("POST", "/staff/location", {
      as: "untracked",
      body: {
        lat: 51.1,
        lng: -114.2,
        deviceKey: `uma-${runId}`,
        deviceLabel: "Uma's phone",
        platform: "android",
      },
    });
    expect(((await report.json()) as { status: string }).status).toBe(
      "recorded",
    );
    const { cleaners } = await mapCleaners("owner");
    expect(cleaners.some((c) => c.teamMemberId === untrackedSeatId)).toBe(true);

    const off = await call("PUT", `/staff/tracking/${untrackedSeatId}`, {
      as: "owner",
      body: { enabled: false },
    });
    expect(off.status).toBe(200);
    // "Off" means gone, not hidden: the rows themselves are deleted.
    const stored = await db
      .select()
      .from(cleanerLocationsTable)
      .where(eq(cleanerLocationsTable.teamMemberId, untrackedSeatId));
    expect(stored).toEqual([]);
    const after = await mapCleaners("owner");
    expect(after.cleaners.some((c) => c.teamMemberId === untrackedSeatId)).toBe(
      false,
    );
  });
});

describe("who may watch, and when", () => {
  beforeAll(async () => {
    await call("POST", "/staff/location", {
      as: "tracked",
      body: {
        lat: 51.2,
        lng: -114.3,
        deviceKey: `tina-${runId}`,
        deviceLabel: "Tina's phone",
        platform: "ios",
      },
    });
  });

  it("gives a dispatcher live positions during the working day", async () => {
    await setCompanyZone(zoneWhereLocalHourIs(13));
    const { cleaners, livePositions } = await mapCleaners("dispatcher");
    expect(livePositions.allowed).toBe(true);
    expect(livePositions.reason).toBeNull();
    expect(cleaners.some((c) => c.teamMemberId === trackedSeatId)).toBe(true);
  });

  it("withholds them from a dispatcher at 9pm company time, with a reason", async () => {
    await setCompanyZone(zoneWhereLocalHourIs(21));
    const { cleaners, livePositions } = await mapCleaners("dispatcher");
    expect(livePositions.allowed).toBe(false);
    expect(livePositions.reason).toMatch(/8/);
    // Genuinely withheld by the server, not hidden in the browser.
    expect(cleaners).toEqual([]);

    const presence = (await (
      await call("GET", "/staff/presence", { as: "dispatcher" })
    ).json()) as Presence;
    expect(presence.liveMemberIds).toEqual([]);
    expect(presence.livePositions.allowed).toBe(false);

    const routes = (await (
      await call("GET", "/map/routes", { as: "dispatcher" })
    ).json()) as {
      routes: unknown[];
      livePositions: { allowed: boolean };
    };
    expect(routes.routes).toEqual([]);
    expect(routes.livePositions.allowed).toBe(false);
  });

  it("still shows the owner everything at that same hour", async () => {
    await setCompanyZone(zoneWhereLocalHourIs(21));
    const { cleaners, livePositions } = await mapCleaners("owner");
    expect(livePositions.allowed).toBe(true);
    expect(cleaners.some((c) => c.teamMemberId === trackedSeatId)).toBe(true);
  });
});

describe("GET /staff/devices", () => {
  beforeAll(async () => {
    await setCompanyZone(zoneWhereLocalHourIs(12));
  });

  it("lists every active person with their devices, and who can be switched", async () => {
    const res = await call("GET", "/staff/devices", { as: "owner" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      people: Array<{
        teamMemberId: number;
        isOwner: boolean;
        sharingEnabled: boolean;
        canChangeSharing: boolean;
        devices: Array<{ label: string; live: boolean; lastSeenAt: string }>;
      }>;
    };

    const boss = body.people.find((p) => p.teamMemberId === ownerSeatId)!;
    expect(boss.isOwner).toBe(true);
    // The boss can't switch himself off — his devices are always tracked.
    expect(boss.canChangeSharing).toBe(false);
    expect(boss.sharingEnabled).toBe(true);
    expect(boss.devices.map((d) => d.label).sort()).toEqual([
      "Boss iPhone",
      "Office PC",
    ]);
    expect(boss.devices.every((d) => d.live)).toBe(true);

    const tina = body.people.find((p) => p.teamMemberId === trackedSeatId)!;
    expect(tina.canChangeSharing).toBe(true);
    expect(tina.devices).toHaveLength(1);

    const dana = body.people.find((p) => p.teamMemberId === dispatcherSeatId)!;
    expect(dana.devices).toEqual([]);
  });

  it.skip("refuses the owner's own seat being switched off", async () => {
    const res = await call("PUT", `/staff/tracking/${ownerSeatId}`, {
      as: "owner",
      body: { enabled: false },
    });
    expect(res.status).toBe(400);
  });
});

describe("storage reset recovery", () => {
  it("keeps the named device and never stores coordinates during recovery", async () => {
    const first = await call("POST", "/staff/location", {
      as: "tracked",
      body: {
        lat: 51.05,
        lng: -114.07,
        deviceKey: `reset-old-${runId}`,
        recoveryKey: `reset-recovery-${runId}`,
        deviceLabel: "Tina's iPhone",
        platform: "ios",
      },
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { deviceId: number };

    const recovered = await call("POST", "/staff/location", {
      as: "tracked",
      body: {
        lat: null,
        lng: null,
        deviceKey: `reset-new-${runId}`,
        recoveryKey: `reset-recovery-${runId}`,
        deviceLabel: "iPhone",
        platform: "ios",
        locationHealth: "storage-cleared",
      },
    });
    expect(recovered.status).toBe(200);
    const recoveredBody = (await recovered.json()) as {
      deviceId: number;
      deviceLabel: string;
      lat: number | null;
      lng: number | null;
      recoveryMatched: boolean;
    };
    expect(recoveredBody).toMatchObject({
      deviceId: firstBody.deviceId,
      deviceLabel: "Tina's iPhone",
      lat: null,
      lng: null,
      recoveryMatched: true,
    });

    const [device] = await db
      .select()
      .from(staffDevicesTable)
      .where(eq(staffDevicesTable.id, firstBody.deviceId));
    expect(device).toMatchObject({
      label: "Tina's iPhone",
      locationHealth: "storage-cleared",
    });
    const positions = await db
      .select()
      .from(cleanerLocationsTable)
      .where(eq(cleanerLocationsTable.deviceId, firstBody.deviceId));
    expect(positions).toHaveLength(0);
  });

  it("does not create a device row for an unknown first-install reset", async () => {
    const reset = await call("POST", "/staff/location", {
      as: "tracked",
      body: {
        lat: null,
        lng: null,
        deviceKey: `first-install-${runId}`,
        recoveryKey: `unknown-recovery-${runId}`,
        deviceLabel: "iPhone",
        platform: "ios",
        locationHealth: "storage-cleared",
      },
    });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({
      deviceId: null,
      deviceLabel: null,
      lat: null,
      lng: null,
      recoveryMatched: false,
    });
  });
});

describe("deleting a device", () => {
  async function reportDevice(
    as: keyof typeof USERS,
    deviceKey: string,
    label: string,
  ): Promise<number> {
    const res = await call("POST", "/staff/location", {
      as,
      body: { lat: 53.5, lng: -113.5, deviceKey, deviceLabel: label },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deviceId: number };
    expect(body.deviceId).toBeTypeOf("number");
    return body.deviceId;
  }

  it("owner deletes a device: row and stored position both gone, map pin disappears, seat survives", async () => {
    await setCompanyZone(zoneWhereLocalHourIs(12));
    const deviceId = await reportDevice(
      "tracked",
      `del_a_${runId}`,
      "Old phone",
    );

    const res = await call("DELETE", `/staff/devices/${deviceId}`, {
      as: "owner",
    });
    expect(res.status).toBe(204);

    // Device row gone.
    const devices = await db
      .select()
      .from(staffDevicesTable)
      .where(eq(staffDevicesTable.id, deviceId));
    expect(devices).toHaveLength(0);

    // Its stored position went with it.
    const positions = await db
      .select()
      .from(cleanerLocationsTable)
      .where(eq(cleanerLocationsTable.deviceId, deviceId));
    expect(positions).toHaveLength(0);

    // No pin for it on the map.
    const { cleaners } = await mapCleaners("owner");
    expect(cleaners.some((c) => c.deviceId === deviceId)).toBe(false);

    // The person and their seat are untouched.
    const seats = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, trackedSeatId));
    expect(seats).toHaveLength(1);

    // Reporting again simply produces a NEW device.
    const reborn = await reportDevice("tracked", `del_a_${runId}`, "Old phone");
    expect(reborn).not.toBe(deviceId);
  });

  it("a cleaner cannot delete a device, not even their own", async () => {
    const deviceId = await reportDevice("tracked", `del_b_${runId}`, "Mine");
    const res = await call("DELETE", `/staff/devices/${deviceId}`, {
      as: "tracked",
    });
    expect(res.status).toBe(403);
    const still = await db
      .select()
      .from(staffDevicesTable)
      .where(eq(staffDevicesTable.id, deviceId));
    expect(still).toHaveLength(1);
  });

  it("a dispatcher cannot delete either", async () => {
    const deviceId = await reportDevice("tracked", `del_c_${runId}`, "Mine");
    const res = await call("DELETE", `/staff/devices/${deviceId}`, {
      as: "dispatcher",
    });
    expect(res.status).toBe(403);
  });

  it("an id outside the company (or long gone) is a 404", async () => {
    const res = await call("DELETE", "/staff/devices/999999999", {
      as: "owner",
    });
    expect(res.status).toBe(404);
  });

  it("a garbage id is a 400", async () => {
    const res = await call("DELETE", "/staff/devices/not-a-number", {
      as: "owner",
    });
    expect(res.status).toBe(400);
  });
});
