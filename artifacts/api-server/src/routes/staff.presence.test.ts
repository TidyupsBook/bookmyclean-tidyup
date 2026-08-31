/**
 * Staff presence — who is "live" right now.
 *
 * "Live" is computed server-side (a location row fresher than the shared
 * window) so the chat dots, the schedule lanes and the map can never disagree
 * about who is out working. These tests pin the definition: a fresh report
 * means live, an old report doesn't, and another company's crew never leaks
 * into the answer. They also pin that the same flag rides along on chat
 * conversations and the contact picker.
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
  companiesTable,
  teamMembersTable,
  cleanerLocationsTable,
  staffConversationsTable,
  staffConversationMembersTable,
  staffMessagesTable,
  type Company,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { LIVE_WITHIN_MS } from "../lib/presence";

const runId = `${Date.now()}_${process.pid}_presence`;
const OWNER = `presence_owner_${runId}`;
const CLEANER_FRESH = `presence_fresh_${runId}`;
const CLEANER_STALE = `presence_stale_${runId}`;
const CLEANER_QUIET = `presence_quiet_${runId}`;
const OTHER_OWNER = `presence_other_owner_${runId}`;
const OTHER_CLEANER = `presence_other_cleaner_${runId}`;

let server: http.Server;
let baseUrl: string;
let company: Company;
let other: Company;
let freshSeat: number;
let staleSeat: number;
let quietSeat: number;
let otherSeat: number;

type JsonResponse = Omit<Response, "json"> & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): Promise<any>;
};

async function call(
  method: string,
  path: string,
  body?: unknown,
  user = OWNER,
): Promise<JsonResponse> {
  const headers: Record<string, string> = { "x-test-user": user };
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  const [main] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: OWNER,
      name: `Presence Co ${runId}`,
      timezone: "America/Edmonton",
    })
    .returning();
  company = main!;
  const [second] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: OTHER_OWNER,
      name: `Presence Other Co ${runId}`,
      timezone: "America/Edmonton",
    })
    .returning();
  other = second!;

  const rows = await db
    .insert(teamMembersTable)
    .values([
      {
        companyId: company.id,
        name: "Owner Pia",
        email: `presence_owner_${runId}@example.com`,
        role: "owner",
        status: "active",
        clerkUserId: OWNER,
      },
      {
        companyId: company.id,
        name: "Fresh Fern",
        email: `presence_fresh_${runId}@example.com`,
        role: "cleaner",
        // Tracking is opt-in per person now; this crew is switched on.
        locationSharing: true,
        status: "active",
        clerkUserId: CLEANER_FRESH,
      },
      {
        companyId: company.id,
        name: "Stale Stan",
        email: `presence_stale_${runId}@example.com`,
        role: "cleaner",
        // Tracking is opt-in per person now; this crew is switched on.
        locationSharing: true,
        status: "active",
        clerkUserId: CLEANER_STALE,
      },
      {
        companyId: company.id,
        name: "Quiet Quinn",
        email: `presence_quiet_${runId}@example.com`,
        role: "cleaner",
        // Tracking is opt-in per person now; this crew is switched on.
        locationSharing: true,
        status: "active",
        clerkUserId: CLEANER_QUIET,
      },
      {
        companyId: other.id,
        name: "Other Ollie",
        email: `presence_other_${runId}@example.com`,
        role: "cleaner",
        // Tracking is opt-in per person now; this crew is switched on.
        locationSharing: true,
        status: "active",
        clerkUserId: OTHER_CLEANER,
      },
    ])
    .returning();
  freshSeat = rows[1]!.id;
  staleSeat = rows[2]!.id;
  quietSeat = rows[3]!.id;
  otherSeat = rows[4]!.id;

  const now = Date.now();
  await db.insert(cleanerLocationsTable).values([
    {
      // Reported a minute ago — live.
      companyId: company.id,
      teamMemberId: freshSeat,
      lat: 51.05,
      lng: -114.07,
      updatedAt: new Date(now - 60_000),
    },
    {
      // Reported just past the window — no longer live.
      companyId: company.id,
      teamMemberId: staleSeat,
      lat: 51.06,
      lng: -114.08,
      updatedAt: new Date(now - (LIVE_WITHIN_MS + 60_000)),
    },
    {
      // Fresh, but someone else's company — must never leak across.
      companyId: other.id,
      teamMemberId: otherSeat,
      lat: 53.55,
      lng: -113.49,
      updatedAt: new Date(now - 30_000),
    },
  ]);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  const companyIds = [company.id, other.id];
  await db
    .delete(staffMessagesTable)
    .where(inArray(staffMessagesTable.companyId, companyIds));
  await db
    .delete(staffConversationMembersTable)
    .where(inArray(staffConversationMembersTable.companyId, companyIds));
  await db
    .delete(staffConversationsTable)
    .where(inArray(staffConversationsTable.companyId, companyIds));
  await db
    .delete(cleanerLocationsTable)
    .where(inArray(cleanerLocationsTable.companyId, companyIds));
  await db
    .delete(teamMembersTable)
    .where(inArray(teamMembersTable.companyId, companyIds));
  await db.delete(companiesTable).where(inArray(companiesTable.id, companyIds));
});

describe("GET /staff/presence", () => {
  it("lists exactly the members whose phone reported within the window", async () => {
    const res = await call("GET", "/staff/presence");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.liveMemberIds).toContain(freshSeat);
    expect(body.liveMemberIds).not.toContain(staleSeat);
    expect(body.liveMemberIds).not.toContain(quietSeat);
    // Another company's fresh report never shows up here.
    expect(body.liveMemberIds).not.toContain(otherSeat);
  });

  it.skip("a cleaner can ask too — same answer the map already shows them", async () => {
    const res = await call("GET", "/staff/presence", undefined, CLEANER_STALE);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.liveMemberIds).toContain(freshSeat);
  });
});

describe("live flags in staff chat", () => {
  it("a chat with someone out working carries their live flag everywhere the thread appears", async () => {
    const started = await (
      await call("POST", "/staff-chat/conversations", {
        memberIds: [freshSeat],
      })
    ).json();
    expect(started.members).toEqual([
      { id: freshSeat, name: "Fresh Fern", isLive: true },
    ]);

    const list = await (await call("GET", "/staff-chat/conversations")).json();
    const row = list.find((c: { id: number }) => c.id === started.id);
    expect(row.members).toEqual([
      { id: freshSeat, name: "Fresh Fern", isLive: true },
    ]);
    // The names-only field stays for anything still reading it.
    expect(row.memberNames).toEqual(["Fresh Fern"]);

    const detail = await (
      await call("GET", `/staff-chat/conversations/${started.id}`)
    ).json();
    expect(detail.conversation.members).toEqual([
      { id: freshSeat, name: "Fresh Fern", isLive: true },
    ]);
  });

  it("an old report reads as not live in a chat", async () => {
    const started = await (
      await call("POST", "/staff-chat/conversations", {
        memberIds: [staleSeat],
      })
    ).json();
    expect(started.members).toEqual([
      { id: staleSeat, name: "Stale Stan", isLive: false },
    ]);
  });

  it("contacts show who is out working right now", async () => {
    const contacts = await (await call("GET", "/staff-chat/contacts")).json();
    const byId = new Map(
      contacts.map((c: { id: number; isLive: boolean }) => [c.id, c.isLive]),
    );
    expect(byId.get(freshSeat)).toBe(true);
    expect(byId.get(staleSeat)).toBe(false);
    expect(byId.get(quietSeat)).toBe(false);
  });

  it("the flag goes dark once the report ages past the window", async () => {
    await db
      .update(cleanerLocationsTable)
      .set({ updatedAt: new Date(Date.now() - (LIVE_WITHIN_MS + 60_000)) })
      .where(eq(cleanerLocationsTable.teamMemberId, freshSeat));

    const contacts = await (await call("GET", "/staff-chat/contacts")).json();
    const fresh = contacts.find((c: { id: number }) => c.id === freshSeat);
    expect(fresh.isLive).toBe(false);

    const presence = await (await call("GET", "/staff/presence")).json();
    expect(presence.liveMemberIds).not.toContain(freshSeat);
  });
});
