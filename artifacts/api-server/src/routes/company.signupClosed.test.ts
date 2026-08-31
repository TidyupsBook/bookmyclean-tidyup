/**
 * A site that belongs to one cleaning company.
 *
 * The same build serves more than one address: the company's own live site,
 * where nobody should be able to sign up and start a rival workspace inside
 * it, and the addresses kept for new owners. The difference is one runtime
 * setting, so these pin what it actually does — including the part that would
 * be a disaster to get wrong, which is that closing the door must never lock
 * out the company already living behind it.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import type { AddressInfo } from "node:net";

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
        emailAddresses: [{ emailAddress: "founder@example.com" }],
        firstName: "Test",
        lastName: "Owner",
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
import { db, pool, companiesTable, teamMembersTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

const runId = `${Date.now()}_${process.pid}`;
const SETTLED = `test_signup_settled_${runId}`;
const STRANGER = `test_signup_stranger_${runId}`;
const NEWCOMER = `test_signup_newcomer_${runId}`;
const LURKER = `test_signup_lurker_${runId}`;
const ALL_USERS = [SETTLED, STRANGER, NEWCOMER, LURKER];

/** The alias the deployment keeps open for new owners. */
const SIGNUP_HOST = "signups.example.com";

let server: http.Server;
let baseUrl: string;

function createCompany(
  name: string,
  asUser: string,
  host?: string,
): Promise<Response> {
  return fetch(`${baseUrl}/api/company`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-user": asUser,
      // How the deployment proxy reports the address the visitor used.
      ...(host ? { "x-forwarded-host": host } : {}),
    },
    body: JSON.stringify({ name }),
  });
}

function whoAmI(asUser: string, host?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/me`, {
    headers: {
      "x-test-user": asUser,
      ...(host ? { "x-forwarded-host": host } : {}),
    },
  });
}

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  delete process.env.NEW_COMPANY_SIGNUPS;
  // The company that already lives here, made while the door was open.
  const res = await createCompany(`Settled Cleaning ${runId}`, SETTLED);
  expect(res.status).toBe(201);
});

afterAll(async () => {
  delete process.env.NEW_COMPANY_SIGNUPS;
  delete process.env.SIGNUP_HOST;
  const companies = await db
    .select({ id: companiesTable.id })
    .from(companiesTable)
    .where(inArray(companiesTable.ownerUserId, ALL_USERS));
  const ids = companies.map((c) => c.id);
  if (ids.length > 0) {
    await db
      .delete(teamMembersTable)
      .where(inArray(teamMembersTable.companyId, ids));
    await db.delete(companiesTable).where(inArray(companiesTable.id, ids));
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe("a site closed to new companies", () => {
  it("turns a stranger away and tells them to ask for a code", async () => {
    process.env.NEW_COMPANY_SIGNUPS = "closed";
    const res = await createCompany(`Rival Cleaning ${runId}`, STRANGER);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/join code/i);

    // Nothing was written on the way to the refusal.
    const rows = await db
      .select()
      .from(companiesTable)
      .where(inArray(companiesTable.ownerUserId, [STRANGER]));
    expect(rows).toHaveLength(0);
  });

  it("still lets the company already here through", async () => {
    process.env.NEW_COMPANY_SIGNUPS = "closed";
    const res = await createCompany(`Settled Cleaning ${runId}`, SETTLED);
    expect(res.status).toBe(201);
  });

  it("tells the app which door to show", async () => {
    process.env.NEW_COMPANY_SIGNUPS = "closed";
    const closed = (await (await whoAmI(SETTLED)).json()) as {
      canCreateCompany: boolean;
    };
    expect(closed.canCreateCompany).toBe(false);

    delete process.env.NEW_COMPANY_SIGNUPS;
    const open = (await (await whoAmI(SETTLED)).json()) as {
      canCreateCompany: boolean;
    };
    expect(open.canCreateCompany).toBe(true);
  });

  it("lets a new owner through on an address kept open", async () => {
    process.env.NEW_COMPANY_SIGNUPS = "open";
    const res = await createCompany(`Brand New Cleaning ${runId}`, STRANGER);
    expect(res.status).toBe(201);
  });
});

describe("a second address on the same closed deployment", () => {
  it("lets a new owner sign up on the signup host while the main door stays shut", async () => {
    process.env.NEW_COMPANY_SIGNUPS = "closed";
    process.env.SIGNUP_HOST = SIGNUP_HOST;

    // The main address still refuses.
    const refused = await createCompany(
      `Front Door Cleaning ${runId}`,
      NEWCOMER,
      "bookmycleaning.net",
    );
    expect(refused.status).toBe(403);

    // The signup address lets them through.
    const res = await createCompany(
      `Second Door Cleaning ${runId}`,
      NEWCOMER,
      SIGNUP_HOST,
    );
    expect(res.status).toBe(201);
  });

  it("shows each address its own door in /me", async () => {
    process.env.NEW_COMPANY_SIGNUPS = "closed";
    process.env.SIGNUP_HOST = SIGNUP_HOST;

    const closed = (await (
      await whoAmI(SETTLED, "bookmycleaning.net")
    ).json()) as { canCreateCompany: boolean };
    expect(closed.canCreateCompany).toBe(false);

    const open = (await (await whoAmI(SETTLED, SIGNUP_HOST)).json()) as {
      canCreateCompany: boolean;
    };
    expect(open.canCreateCompany).toBe(true);
  });

  it("keeps the company created there completely separate from the settled one", async () => {
    const rows = await db
      .select({
        id: companiesTable.id,
        ownerUserId: companiesTable.ownerUserId,
        joinCode: companiesTable.joinCode,
      })
      .from(companiesTable)
      .where(inArray(companiesTable.ownerUserId, [SETTLED, NEWCOMER]));
    const settled = rows.find((r) => r.ownerUserId === SETTLED);
    const newcomer = rows.find((r) => r.ownerUserId === NEWCOMER);
    expect(settled).toBeDefined();
    expect(newcomer).toBeDefined();
    expect(newcomer!.id).not.toBe(settled!.id);
    // Distinct join codes (when issued): the settled crew's code can never
    // land someone in the newcomer's company or vice versa.
    if (settled!.joinCode && newcomer!.joinCode) {
      expect(newcomer!.joinCode).not.toBe(settled!.joinCode);
    }

    // No shared roster: each company's team members belong to it alone.
    const seats = await db
      .select({
        companyId: teamMembersTable.companyId,
      })
      .from(teamMembersTable)
      .where(inArray(teamMembersTable.companyId, [settled!.id, newcomer!.id]));
    // Every seat sits in exactly one of the two companies; nothing overlaps
    // because membership is a single companyId, but pin that both rosters
    // are non-empty and disjoint by construction.
    expect(seats.some((s) => s.companyId === settled!.id)).toBe(true);
    expect(seats.some((s) => s.companyId === newcomer!.id)).toBe(true);
  });

  it("an empty or missing host never opens the door", async () => {
    process.env.NEW_COMPANY_SIGNUPS = "closed";
    process.env.SIGNUP_HOST = SIGNUP_HOST;
    // No forwarded host at all: fetch sends Host: 127.0.0.1:port, which is
    // not the signup host — still refused.
    const res = await createCompany(`No Host Cleaning ${runId}`, LURKER);
    expect(res.status).toBe(403);
    delete process.env.SIGNUP_HOST;
  });
});
