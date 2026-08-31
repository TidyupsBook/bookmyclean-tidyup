/**
 * Multi-account Jobber connection management.
 *
 * Covers three correctness properties that the code review required:
 *
 * 1. Connecting a second Jobber account (OAuth callback) does NOT overwrite the
 *    primary connection's credentials in companies.jobber_*.
 *
 * 2. Deleting the primary connection promotes the next-oldest connection to
 *    primary and mirrors its credentials into companies.jobber_* so every
 *    existing sync path keeps working without being rewritten.
 *
 * 3. PATCH /team/:id with a jobberConnectionId that belongs to a different
 *    company returns 400 (cross-tenant connection assignment rejected).
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type http from "node:http";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
  // Provide a stable fake encryption key so secretBox doesn't crash. The 32
  // hex pairs below are just test bytes — never used in production.
  process.env.SECRET_KEY =
    "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
});

// ---------------------------------------------------------------------------
// Infrastructure mocks (same as every other route test in this package)
// ---------------------------------------------------------------------------

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
      deleteUser: vi.fn(async () => undefined),
    },
    invitations: {
      revokeInvitation: vi.fn(async () => undefined),
      createInvitation: vi.fn(async () => ({ id: "inv_test" })),
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

// ---------------------------------------------------------------------------
// Jobber API mocks — only the functions that make outbound HTTP calls
// ---------------------------------------------------------------------------

const mockExchangeCode = vi.fn(async (_args: unknown) => ({
  access_token: "secondary-access-token",
  refresh_token: "secondary-refresh-token",
  expires_in: 3600,
}));

const mockFetchAccount = vi.fn(async (_token: string) => ({
  id: "jobber-account-B",
  name: "Night Crew",
}));

vi.mock("../lib/jobber", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/jobber")>();
  return {
    ...actual,
    exchangeAuthorizationCode: (args: unknown) => mockExchangeCode(args),
    fetchJobberAccount: (token: string) => mockFetchAccount(token),
    // disconnectJobberApp is best-effort in the DELETE handler; let it no-op.
    disconnectJobberApp: vi.fn(async () => undefined),
  };
});

// ---------------------------------------------------------------------------
// secretBox mock — returns predictable values so we can assert on tokens
// ---------------------------------------------------------------------------

vi.mock("../lib/secretBox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/secretBox")>();
  return {
    ...actual,
    // Prefix with "enc:" so tests can recognise which value was persisted.
    encryptJobberToken: (token: string) => `enc:${token}`,
    decryptJobberToken: (payload: string | null) =>
      payload?.startsWith("enc:") ? payload.slice(4) : payload,
  };
});

// ---------------------------------------------------------------------------
// App + DB imports (after mocks)
// ---------------------------------------------------------------------------

import app from "../app";
import {
  db,
  pool,
  companiesTable,
  teamMembersTable,
  activityTable,
  jobberConnectionsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

const runId = `${Date.now()}_${process.pid}`;
const OWNER_A = `jmc_ownerA_${runId}`;
const OWNER_B = `jmc_ownerB_${runId}`;

let server: http.Server;
let baseUrl: string;

/** Company A: has Jobber connected; used for connection-management tests */
let companyA: number;

/** Company B: used for cross-tenant rejection test */
let companyB: number;

/** Staff member that belongs to company B */
let memberBId: number;

/** Jobber connection belonging to company A */
let connAId: number;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  // Company A: already has Jobber connected and one primary connection row.
  const [ca] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: OWNER_A,
      name: `Jobber Connections Test Co A ${runId}`,
      timezone: "America/Edmonton",
      jobberConnected: true,
      jobberAccountId: "jobber-account-A",
      jobberAccountName: "Main Crew",
      jobberAccessToken: "enc:primary-access-token",
      jobberRefreshToken: "enc:primary-refresh-token",
    })
    .returning();
  companyA = ca!.id;

  // Company B: no Jobber; its owner will try to assign company A's connection.
  const [cb] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: OWNER_B,
      name: `Jobber Connections Test Co B ${runId}`,
      timezone: "America/Edmonton",
    })
    .returning();
  companyB = cb!.id;

  // Staff member on company B.
  const [mb] = await db
    .insert(teamMembersTable)
    .values({
      companyId: companyB,
      name: "Staff B",
      role: "cleaner",
      active: true,
    })
    .returning();
  memberBId = mb!.id;
});

afterAll(async () => {
  await db
    .delete(jobberConnectionsTable)
    .where(eq(jobberConnectionsTable.companyId, companyA));
  await db.delete(activityTable).where(eq(activityTable.companyId, companyA));
  await db
    .delete(teamMembersTable)
    .where(eq(teamMembersTable.companyId, companyA));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyA));

  await db
    .delete(teamMembersTable)
    .where(eq(teamMembersTable.companyId, companyB));
  await db
    .delete(jobberConnectionsTable)
    .where(eq(jobberConnectionsTable.companyId, companyB));
  await db.delete(activityTable).where(eq(activityTable.companyId, companyB));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyB));

  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await pool.end();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function authedFetch(
  path: string,
  userId: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-test-user": userId,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

async function seedConnections(count: number): Promise<void> {
  await db
    .delete(jobberConnectionsTable)
    .where(eq(jobberConnectionsTable.companyId, companyA));
  if (count === 0) return;
  await db.insert(jobberConnectionsTable).values(
    Array.from({ length: count }, (_, index) => ({
      companyId: companyA,
      accountId: `seed-account-${index}`,
      accountName: `Seed crew ${index + 1}`,
      accessToken: `enc:seed-access-${index}`,
      refreshToken: `enc:seed-refresh-${index}`,
      isPrimary: index === 0,
    })),
  );
}

async function setOAuthState(state: string): Promise<void> {
  await db
    .update(companiesTable)
    .set({
      jobberOauth: {
        state,
        redirectUri: "http://localhost/redirect",
        verifier: "test-verifier",
        createdAt: new Date().toISOString(),
      },
    })
    .where(eq(companiesTable.id, companyA));
}

// ---------------------------------------------------------------------------
// Test 1 – OAuth callback: secondary account does NOT overwrite primary tokens
// ---------------------------------------------------------------------------

describe("OAuth callback: second account connect", () => {
  beforeEach(async () => {
    // Ensure company A has exactly one primary connection before each test.
    await db
      .delete(jobberConnectionsTable)
      .where(eq(jobberConnectionsTable.companyId, companyA));

    const [conn] = await db
      .insert(jobberConnectionsTable)
      .values({
        companyId: companyA,
        accountId: "jobber-account-A",
        accountName: "Main Crew",
        accessToken: "enc:primary-access-token",
        refreshToken: "enc:primary-refresh-token",
        isPrimary: true,
      })
      .returning();
    connAId = conn!.id;

    // Set up the OAuth state on the company row so the callback can verify it.
    await db
      .update(companiesTable)
      .set({
        jobberOauth: {
          state: `test-state-${runId}`,
          redirectUri: "http://localhost/redirect",
          verifier: "test-verifier",
          createdAt: new Date().toISOString(),
        },
        jobberAccessToken: "enc:primary-access-token",
        jobberAccountId: "jobber-account-A",
        jobberAccountName: "Main Crew",
      })
      .where(eq(companiesTable.id, companyA));

    // Mock returns a DIFFERENT (secondary) account.
    mockExchangeCode.mockResolvedValue({
      access_token: "secondary-access-token",
      refresh_token: "secondary-refresh-token",
      expires_in: 3600,
    });
    mockFetchAccount.mockResolvedValue({
      id: "jobber-account-B",
      name: "Night Crew",
    });
  });

  it("creates a new connection row with isPrimary=false", async () => {
    const res = await fetch(
      `${baseUrl}/api/company/jobber/callback?code=testcode&state=${encodeURIComponent(`test-state-${runId}`)}`,
      { redirect: "manual" },
    );

    // Callback always redirects.
    expect(res.status).toBe(302);

    const connections = await db
      .select()
      .from(jobberConnectionsTable)
      .where(eq(jobberConnectionsTable.companyId, companyA));

    const secondary = connections.find(
      (c) => c.accountId === "jobber-account-B",
    );
    expect(secondary).toBeDefined();
    expect(secondary!.isPrimary).toBe(false);
    expect(secondary!.accountName).toBe("Night Crew");
  });

  it("leaves companies.jobber_* pointing at the original primary's credentials", async () => {
    await fetch(
      `${baseUrl}/api/company/jobber/callback?code=testcode&state=${encodeURIComponent(`test-state-${runId}`)}`,
      { redirect: "manual" },
    );

    const [company] = await db
      .select({
        jobberAccessToken: companiesTable.jobberAccessToken,
        jobberAccountId: companiesTable.jobberAccountId,
      })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyA));

    // Must still hold the PRIMARY's token, not the secondary's.
    expect(company!.jobberAccessToken).toBe("enc:primary-access-token");
    expect(company!.jobberAccountId).toBe("jobber-account-A");
  });
});

// ---------------------------------------------------------------------------
// Test 2 – DELETE primary: promotes the next connection
// ---------------------------------------------------------------------------

describe("DELETE /company/jobber-connections/:id — primary with a secondary", () => {
  let primaryId: number;
  let secondaryId: number;

  beforeEach(async () => {
    await db
      .delete(jobberConnectionsTable)
      .where(eq(jobberConnectionsTable.companyId, companyA));

    // Insert two connections: primary first (older createdAt), secondary second.
    const [p] = await db
      .insert(jobberConnectionsTable)
      .values({
        companyId: companyA,
        accountId: "jobber-account-A",
        accountName: "Main Crew",
        accessToken: "enc:primary-access",
        refreshToken: "enc:primary-refresh",
        isPrimary: true,
      })
      .returning();
    primaryId = p!.id;

    const [s] = await db
      .insert(jobberConnectionsTable)
      .values({
        companyId: companyA,
        accountId: "jobber-account-B",
        accountName: "Night Crew",
        accessToken: "enc:secondary-access",
        refreshToken: "enc:secondary-refresh",
        isPrimary: false,
      })
      .returning();
    secondaryId = s!.id;

    // Reset companies table to hold primary's credentials.
    await db
      .update(companiesTable)
      .set({
        jobberConnected: true,
        jobberAccountId: "jobber-account-A",
        jobberAccountName: "Main Crew",
        jobberAccessToken: "enc:primary-access",
        jobberRefreshToken: "enc:primary-refresh",
      })
      .where(eq(companiesTable.id, companyA));
  });

  it("promotes the secondary to isPrimary=true", async () => {
    const res = await authedFetch(
      `/company/jobber-connections/${primaryId}`,
      OWNER_A,
      { method: "DELETE" },
    );
    expect(res.status).toBe(204);

    const [secondary] = await db
      .select({ isPrimary: jobberConnectionsTable.isPrimary })
      .from(jobberConnectionsTable)
      .where(eq(jobberConnectionsTable.id, secondaryId));

    expect(secondary!.isPrimary).toBe(true);
  });

  it("mirrors the promoted connection's credentials into companies.jobber_*", async () => {
    const res = await authedFetch(
      `/company/jobber-connections/${primaryId}`,
      OWNER_A,
      { method: "DELETE" },
    );
    expect(res.status).toBe(204);

    const [company] = await db
      .select({
        jobberAccessToken: companiesTable.jobberAccessToken,
        jobberAccountId: companiesTable.jobberAccountId,
        jobberConnected: companiesTable.jobberConnected,
      })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyA));

    // companies table must now carry the SECONDARY's credentials.
    expect(company!.jobberConnected).toBe(true);
    expect(company!.jobberAccountId).toBe("jobber-account-B");
    expect(company!.jobberAccessToken).toBe("enc:secondary-access");
  });

  it("deletes the primary row from jobber_connections", async () => {
    await authedFetch(`/company/jobber-connections/${primaryId}`, OWNER_A, {
      method: "DELETE",
    });

    const [gone] = await db
      .select({ id: jobberConnectionsTable.id })
      .from(jobberConnectionsTable)
      .where(eq(jobberConnectionsTable.id, primaryId));

    expect(gone).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 3 – DELETE last connection: fully disconnects the company
// ---------------------------------------------------------------------------

describe("DELETE /company/jobber-connections/:id — last remaining connection", () => {
  let onlyConnId: number;

  beforeEach(async () => {
    await db
      .delete(jobberConnectionsTable)
      .where(eq(jobberConnectionsTable.companyId, companyA));

    const [c] = await db
      .insert(jobberConnectionsTable)
      .values({
        companyId: companyA,
        accountId: "jobber-account-A",
        accountName: "Main Crew",
        accessToken: "enc:only-access",
        refreshToken: "enc:only-refresh",
        isPrimary: true,
      })
      .returning();
    onlyConnId = c!.id;

    await db
      .update(companiesTable)
      .set({
        jobberConnected: true,
        jobberAccountId: "jobber-account-A",
        jobberAccessToken: "enc:only-access",
      })
      .where(eq(companiesTable.id, companyA));
  });

  it("sets jobberConnected=false on the company", async () => {
    const res = await authedFetch(
      `/company/jobber-connections/${onlyConnId}`,
      OWNER_A,
      { method: "DELETE" },
    );
    expect(res.status).toBe(204);

    const [company] = await db
      .select({ jobberConnected: companiesTable.jobberConnected })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyA));

    expect(company!.jobberConnected).toBe(false);
  });

  it("clears the token columns on the company", async () => {
    await authedFetch(`/company/jobber-connections/${onlyConnId}`, OWNER_A, {
      method: "DELETE",
    });

    const [company] = await db
      .select({
        jobberAccessToken: companiesTable.jobberAccessToken,
        jobberAccountId: companiesTable.jobberAccountId,
      })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyA));

    expect(company!.jobberAccessToken).toBeNull();
    expect(company!.jobberAccountId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 4 – PATCH /team/:id: cross-company jobberConnectionId is rejected
// ---------------------------------------------------------------------------

describe("PATCH /team/:id — jobberConnectionId cross-tenant guard", () => {
  beforeEach(async () => {
    await db
      .delete(jobberConnectionsTable)
      .where(eq(jobberConnectionsTable.companyId, companyA));

    const [conn] = await db
      .insert(jobberConnectionsTable)
      .values({
        companyId: companyA, // belongs to company A
        accountId: "jobber-account-A",
        accountName: "Main Crew",
        accessToken: "enc:access",
        refreshToken: "enc:refresh",
        isPrimary: true,
      })
      .returning();
    connAId = conn!.id;
  });

  it("returns 400 when the connection belongs to another company", async () => {
    // OWNER_B is the owner of company B, trying to assign company A's connection
    // to a staff member that belongs to company B.
    const res = await authedFetch(`/team/${memberBId}`, OWNER_B, {
      method: "PATCH",
      body: JSON.stringify({
        name: "Staff B",
        jobberConnectionId: connAId, // company A's connection — should be rejected
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown jobber connection/i);
  });

  it("allows clearing jobberConnectionId (null) without a company-scope check", async () => {
    const res = await authedFetch(`/team/${memberBId}`, OWNER_B, {
      method: "PATCH",
      body: JSON.stringify({
        name: "Staff B",
        jobberConnectionId: null,
      }),
    });
    // null is always allowed — it means "use the primary" and references nothing.
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Test 5 – capacity, labels, and temporary roster-only staff assignments
// ---------------------------------------------------------------------------

describe("Jobber connection capacity and owner labels", () => {
  beforeEach(async () => {
    mockExchangeCode.mockResolvedValue({
      access_token: "secondary-access-token",
      refresh_token: "secondary-refresh-token",
      expires_in: 3600,
    });
    mockFetchAccount.mockResolvedValue({
      id: "new-jobber-account",
      name: "New Crew",
    });
  });

  it("accepts the twentieth distinct Jobber account", async () => {
    await seedConnections(19);
    const state = `twentieth-${runId}`;
    await setOAuthState(state);

    const res = await fetch(
      `${baseUrl}/api/company/jobber/callback?code=twentieth&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("jobber=connected");

    const rows = await db
      .select({ id: jobberConnectionsTable.id })
      .from(jobberConnectionsTable)
      .where(eq(jobberConnectionsTable.companyId, companyA));
    expect(rows).toHaveLength(20);
    const [company] = await db
      .select({ jobberOauth: companiesTable.jobberOauth })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyA));
    expect(company!.jobberOauth).toBeNull();
  });

  it("rejects a twenty-first distinct account with a clear message", async () => {
    await seedConnections(20);
    const state = `twenty-first-${runId}`;
    await setOAuthState(state);

    const res = await fetch(
      `${baseUrl}/api/company/jobber/callback?code=twenty-first&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain(
      "You can connect up to 20 Jobber accounts",
    );

    const rows = await db
      .select({ id: jobberConnectionsTable.id })
      .from(jobberConnectionsTable)
      .where(eq(jobberConnectionsTable.companyId, companyA));
    expect(rows).toHaveLength(20);
  });

  it("does not let concurrent callbacks create a twenty-first row", async () => {
    await seedConnections(19);
    const state = `concurrent-${runId}`;
    await setOAuthState(state);
    mockExchangeCode.mockImplementation(async ({ code }: { code: string }) => ({
      access_token: `access-${code}`,
      refresh_token: `refresh-${code}`,
      expires_in: 3600,
    }));
    mockFetchAccount.mockImplementation(async (token: string) => ({
      id: token === "access-one" ? "new-account-one" : "new-account-two",
      name: token === "access-one" ? "First extra crew" : "Second extra crew",
    }));

    const [first, second] = await Promise.all(
      ["one", "two"].map((code) =>
        fetch(
          `${baseUrl}/api/company/jobber/callback?code=${code}&state=${encodeURIComponent(state)}`,
          { redirect: "manual" },
        ),
      ),
    );
    expect([first.status, second.status]).toEqual([302, 302]);

    const rows = await db
      .select({ id: jobberConnectionsTable.id })
      .from(jobberConnectionsTable)
      .where(eq(jobberConnectionsTable.companyId, companyA));
    expect(rows).toHaveLength(20);
    // The shared OAuth state is one-use, so a racing browser may instead see
    // the normal expired-attempt message before it reaches the capacity check.
    // Either way, the advisory lock ensures this company never reaches 21.
  });

  it("persists a freely chosen local account name", async () => {
    await seedConnections(1);
    const [connection] = await db
      .select()
      .from(jobberConnectionsTable)
      .where(eq(jobberConnectionsTable.companyId, companyA));

    const res = await authedFetch(
      `/company/jobber-connections/${connection!.id}`,
      OWNER_A,
      {
        method: "PATCH",
        body: JSON.stringify({ displayName: "Richard's iPhone crew" }),
      },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { displayName: string }).displayName).toBe(
      "Richard's iPhone crew",
    );
  });
});

describe("Temporary staff Jobber assignments", () => {
  let companyBConnectionId: number;

  beforeEach(async () => {
    await db
      .delete(jobberConnectionsTable)
      .where(eq(jobberConnectionsTable.companyId, companyB));
    const [connection] = await db
      .insert(jobberConnectionsTable)
      .values({
        companyId: companyB,
        accountId: `temporary-staff-${runId}`,
        accountName: "Temporary staff crew",
        accessToken: "enc:temporary-access",
        refreshToken: "enc:temporary-refresh",
        isPrimary: true,
      })
      .returning();
    companyBConnectionId = connection!.id;
  });

  it("keeps a temporary staff member's selected connection when they receive a login", async () => {
    const create = await authedFetch("/team", OWNER_B, {
      method: "POST",
      body: JSON.stringify({
        name: "Temporary Cleaner",
        role: "cleaner",
        jobberConnectionId: companyBConnectionId,
      }),
    });
    expect(create.status).toBe(201);
    const temporary = (await create.json()) as {
      id: number;
      email: string | null;
      jobberConnectionId: number | null;
    };
    expect(temporary.email).toBeNull();
    expect(temporary.jobberConnectionId).toBe(companyBConnectionId);

    const promote = await authedFetch(`/team/${temporary.id}`, OWNER_B, {
      method: "PATCH",
      body: JSON.stringify({
        email: `temporary-${runId}@example.com`,
      }),
    });
    expect(promote.status).toBe(200);
    expect(
      ((await promote.json()) as { jobberConnectionId: number | null })
        .jobberConnectionId,
    ).toBe(companyBConnectionId);
  });
});
