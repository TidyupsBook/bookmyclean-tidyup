/**
 * Global directory search integration tests.
 *
 * Same live-app-against-real-DB style as the other route tests: Clerk is the
 * only thing mocked (caller id via x-test-user).
 *
 * What matters most here:
 *  1. Company scoping — a search can never surface another company's people.
 *  2. Phone matching is digit-normalized on BOTH sides: "(555) 010" finds a
 *     number stored as "+1555010..." and one stored as typed.
 *  3. The endpoint is owner/dispatcher only.
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
  companiesTable,
  teamMembersTable,
  bookingsTable,
  leadsTable,
  clientsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const runId = `${Date.now()}_${process.pid}`;
const USERS = {
  owner: `search_owner_${runId}`,
  dispatcher: `search_dispatcher_${runId}`,
  cleaner: `search_cleaner_${runId}`,
};

// Run-unique digits so parallel/stale fixture rows never collide with ours.
const DIGITS = `${Date.now()}`.slice(-7);

let server: http.Server;
let baseUrl: string;
let companyId: number;
let otherCompanyId: number;

type JsonResponse = Omit<Response, "json"> & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): Promise<any>;
};

async function call(
  path: string,
  opts: { as?: keyof typeof USERS | null } = {},
): Promise<JsonResponse> {
  const headers: Record<string, string> = {};
  if (opts.as) headers["x-test-user"] = USERS[opts.as];
  return fetch(`${baseUrl}/api${path}`, { headers });
}

beforeAll(async () => {
  const companies = await db
    .insert(companiesTable)
    .values([
      {
        ownerUserId: USERS.owner,
        name: `Search Co ${runId}`,
        timezone: "America/Toronto",
      },
      {
        ownerUserId: `search_other_owner_${runId}`,
        name: `Search Other Co ${runId}`,
        timezone: "America/Toronto",
      },
    ])
    .returning();
  companyId = companies[0]!.id;
  otherCompanyId = companies[1]!.id;

  await db.insert(teamMembersTable).values([
    {
      companyId,
      name: `Dispatch Dana ${runId}`,
      email: `search_disp_${runId}@test.invalid`,
      role: "dispatcher",
      status: "active",
      clerkUserId: USERS.dispatcher,
    },
    {
      companyId,
      name: `Cleaner Zebulon ${runId}`,
      email: `search_cleaner_${runId}@test.invalid`,
      role: "cleaner",
      status: "active",
      clerkUserId: USERS.cleaner,
      phone: `(403) ${DIGITS.slice(0, 3)}-${DIGITS.slice(3)}`,
    },
    {
      companyId: otherCompanyId,
      name: `Zebulon OtherCo ${runId}`,
      email: `search_other_cleaner_${runId}@test.invalid`,
      role: "cleaner",
      status: "active",
    },
  ]);

  await db.insert(bookingsTable).values([
    {
      companyId,
      callId: null,
      customerName: `Zebulon Bookington ${runId}`,
      customerPhone: `+1587${DIGITS}`,
      service: "Deep clean",
      scheduledFor: new Date("2030-06-01T17:00:00Z"),
      status: "confirmed",
    },
    {
      companyId: otherCompanyId,
      callId: null,
      customerName: `Zebulon NotYours ${runId}`,
      customerPhone: `+1587${DIGITS}`,
      service: "Deep clean",
      scheduledFor: new Date("2030-06-02T17:00:00Z"),
      status: "confirmed",
    },
  ]);

  await db.insert(leadsTable).values({
    companyId,
    externalId: `search_lead_${runId}`,
    sourceTab: "Facebook",
    source: "facebook",
    status: "new",
    firstName: "Zebulon",
    lastName: `Leadman ${runId}`,
    phoneNumber: `587-${DIGITS.slice(0, 3)}-${DIGITS.slice(3)}`,
    phoneE164: `+1587${DIGITS}`,
  });

  await db.insert(clientsTable).values({
    companyId,
    name: `Zebulon Clientworth ${runId}`,
    phone: `587 ${DIGITS}`,
    phoneE164: `+1587${DIGITS}`,
    source: "manual",
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await db
    .delete(leadsTable)
    .where(inArray(leadsTable.companyId, [companyId, otherCompanyId]));
  await db
    .delete(clientsTable)
    .where(inArray(clientsTable.companyId, [companyId, otherCompanyId]));
  await db
    .delete(bookingsTable)
    .where(inArray(bookingsTable.companyId, [companyId, otherCompanyId]));
  await db
    .delete(teamMembersTable)
    .where(inArray(teamMembersTable.companyId, [companyId, otherCompanyId]));
  await db
    .delete(companiesTable)
    .where(inArray(companiesTable.id, [companyId, otherCompanyId]));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /search", () => {
  it("requires auth and dispatcher-or-owner role", async () => {
    expect((await call(`/search?q=zeb`)).status).toBe(401);
    expect((await call(`/search?q=zeb`, { as: "cleaner" })).status).toBe(403);
  });

  it("finds people by name across all four kinds, scoped to the company", async () => {
    const res = await call(`/search?q=Zebulon`, { as: "owner" });
    expect(res.status).toBe(200);
    const { results } = await res.json();
    const kinds = results.map((r: { kind: string }) => r.kind).sort();
    expect(kinds).toEqual(["booking", "client", "lead", "team"]);
    const names = results.map((r: { name: string }) => r.name).join("|");
    expect(names).not.toContain("NotYours");
    expect(names).not.toContain("OtherCo");
  });

  it("matches phone numbers regardless of stored or typed format", async () => {
    // Query typed with punctuation; stored values span E.164, dashed, spaced.
    const res = await call(
      `/search?q=${encodeURIComponent(`(587) ${DIGITS.slice(0, 3)}-${DIGITS.slice(3)}`)}`,
      { as: "dispatcher" },
    );
    expect(res.status).toBe(200);
    const { results } = await res.json();
    const kinds = results.map((r: { kind: string }) => r.kind);
    expect(kinds).toContain("lead");
    expect(kinds).toContain("booking");
    expect(kinds).toContain("client");
  });

  it("matches a partial name case-insensitively", async () => {
    const res = await call(`/search?q=clientworth`, { as: "owner" });
    const { results } = await res.json();
    expect(results.some((r: { kind: string }) => r.kind === "client")).toBe(
      true,
    );
  });

  it("returns nothing for a sub-2-character query instead of everything", async () => {
    const res = await call(`/search?q=z`, { as: "owner" });
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([]);
  });

  it("treats LIKE wildcards as literals", async () => {
    const res = await call(`/search?q=${encodeURIComponent("%%")}`, {
      as: "owner",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([]);
  });
});
