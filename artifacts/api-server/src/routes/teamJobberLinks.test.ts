/**
 * Jobber ↔ staff link management.
 *
 * Same live-app-against-real-DB style as team.test.ts: Clerk is mocked for
 * caller identity, and Jobber's user list is stubbed at our client helper —
 * these tests are about who may store which link, not about GraphQL.
 *
 * What's pinned here: saying who somebody IS in Jobber is the owner's call
 * alone; one Jobber user can never sit on two seats; unlinking hands the
 * seat back to name matching (visible in the preview immediately); and an
 * import creates a roster-only seat — no email, no login — already linked.
 */
import {
  beforeAll,
  afterAll,
  beforeEach,
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

// Only the pieces the link routes call are faked; everything else in the
// Jobber client stays real so nothing else quietly changes behaviour.
const { listJobberUsersMock } = vi.hoisted(() => ({
  listJobberUsersMock:
    vi.fn<
      (accessToken: string) => Promise<Array<{ id: string; name: string }>>
    >(),
}));
vi.mock("../lib/jobber", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/jobber")>("../lib/jobber");
  return {
    ...actual,
    getValidAccessToken: vi.fn(async () => "test-token"),
    getValidConnectionToken: vi.fn(
      async (connection: { id: number }) => `connection-${connection.id}`,
    ),
    listJobberUsers: (accessToken: string) => listJobberUsersMock(accessToken),
  };
});

import app from "../app";
import {
  db,
  pool,
  companiesTable,
  teamMembersTable,
  activityTable,
  jobberConnectionsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

const runId = `${Date.now()}_${process.pid}`;
const USERS = {
  owner: `jlink_owner_${runId}`,
  dispatcher: `jlink_dispatcher_${runId}`,
  cleaner: `jlink_cleaner_${runId}`,
};

// Jobber's side of the fence.
const JU_GRETA = `ju_greta_${runId}`;
const JU_MARCO = `ju_marco_${runId}`;
const JU_ZED = `ju_zed_${runId}`;
const JOBBER_USERS = [
  // Prefix of roster "Greta Holt" — the sync's matcher suggests her.
  { id: JU_GRETA, name: "Greta Holt Gill" },
  // Named nothing like his seat — only the stored link says who he is.
  { id: JU_MARCO, name: "M. Silva-Reyes" },
  // Nobody on the roster.
  { id: JU_ZED, name: "Zed Nobody" },
];

let server: http.Server;
let baseUrl: string;
let companyId: number;
let gretaId: number;
let marcoId: number;
let cleanerSeatId: number;

type JsonResponse = Omit<Response, "json"> & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): Promise<any>;
};

async function call(
  method: string,
  path: string,
  opts: { as?: keyof typeof USERS; body?: unknown } = {},
): Promise<JsonResponse> {
  const headers: Record<string, string> = {};
  if (opts.as) headers["x-test-user"] = USERS[opts.as];
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  return fetch(`${baseUrl}/api${path}`, { method, headers, body });
}

async function jobberRows() {
  const res = await call("GET", "/team/jobber-members", { as: "owner" });
  expect(res.status).toBe(200);
  const { members } = (await res.json()) as {
    members: Array<{
      jobberUserId: string;
      name: string;
      linkedTeamMemberId: number | null;
      suggestedTeamMemberId: number | null;
    }>;
  };
  return new Map(members.map((r) => [r.jobberUserId, r]));
}

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: USERS.owner,
      name: `Jobber Link Co ${runId}`,
      timezone: "America/Toronto",
      jobberConnected: true,
      jobberAccessToken: "enc",
      jobberRefreshToken: "enc",
    })
    .returning();
  companyId = company!.id;

  const seats = await db
    .insert(teamMembersTable)
    .values([
      {
        companyId,
        name: "Dispatch Dana",
        email: `jlink_disp_${runId}@test.invalid`,
        role: "dispatcher",
        status: "active",
        clerkUserId: USERS.dispatcher,
      },
      {
        companyId,
        name: "Cleaner Cass",
        email: `jlink_cleaner_${runId}@test.invalid`,
        role: "cleaner",
        status: "active",
        clerkUserId: USERS.cleaner,
      },
      { companyId, name: "Greta Holt", role: "cleaner", status: "active" },
      {
        companyId,
        name: "Marco Silva",
        role: "cleaner",
        status: "active",
        jobberUserId: JU_MARCO,
      },
    ])
    .returning();
  cleanerSeatId = seats.find((s) => s.clerkUserId === USERS.cleaner)!.id;
  gretaId = seats.find((s) => s.name === "Greta Holt")!.id;
  marcoId = seats.find((s) => s.name === "Marco Silva")!.id;

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
  await db
    .delete(teamMembersTable)
    .where(eq(teamMembersTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end();
});

beforeEach(() => {
  listJobberUsersMock.mockReset();
  listJobberUsersMock.mockResolvedValue(JOBBER_USERS);
});

describe("listing Jobber's team", () => {
  it("is not for cleaners", async () => {
    const res = await call("GET", "/team/jobber-members", { as: "cleaner" });
    expect(res.status).toBe(403);
  });

  it("shows a dispatcher who's linked, who's suggested, who's a stranger", async () => {
    const res = await call("GET", "/team/jobber-members", {
      as: "dispatcher",
    });
    expect(res.status).toBe(200);
    const { members } = (await res.json()) as {
      members: Array<{ jobberUserId: string }>;
    };
    const rows = new Map(members.map((r) => [r.jobberUserId, r] as const));

    expect(rows.get(JU_MARCO)).toMatchObject({
      name: "M. Silva-Reyes",
      linkedTeamMemberId: marcoId,
      suggestedTeamMemberId: null,
    });
    expect(rows.get(JU_GRETA)).toMatchObject({
      linkedTeamMemberId: null,
      suggestedTeamMemberId: gretaId,
    });
    expect(rows.get(JU_ZED)).toMatchObject({
      linkedTeamMemberId: null,
      suggestedTeamMemberId: null,
    });
  });

  it("surfaces a roster member whose linked Jobber user vanished", async () => {
    // A seat linked to a Jobber user that Jobber no longer lists — the
    // account was deactivated there. The stale link must be visible, not
    // silently swallowed because the active list doesn't mention it.
    const ghostJobberId = `ju_ghost_${runId}`;
    const [ghost] = await db
      .insert(teamMembersTable)
      .values({
        companyId,
        name: "Ghost Greaves",
        role: "cleaner",
        status: "active",
        jobberUserId: ghostJobberId,
      })
      .returning();
    try {
      const rows = await jobberRows();
      expect(rows.get(ghostJobberId)).toMatchObject({
        name: "Ghost Greaves",
        linkedTeamMemberId: ghost!.id,
        suggestedTeamMemberId: null,
        gone: true,
      });
      // Active Jobber users are never marked gone.
      expect(rows.get(JU_MARCO)).toMatchObject({ gone: false });
    } finally {
      await db
        .delete(teamMembersTable)
        .where(eq(teamMembersTable.id, ghost!.id));
    }
  });

  it("says Jobber is unreachable instead of pretending an empty team", async () => {
    listJobberUsersMock.mockRejectedValue(new Error("boom"));
    const res = await call("GET", "/team/jobber-members", { as: "owner" });
    expect(res.status).toBe(502);
  });

  it("marks an incomplete multi-account roster and refuses owner link changes", async () => {
    const [main, unavailable] = await db
      .insert(jobberConnectionsTable)
      .values([
        { companyId, displayName: "Main crew" },
        { companyId, displayName: "Night crew" },
      ])
      .returning();
    listJobberUsersMock.mockImplementation(async (accessToken) => {
      if (accessToken === `connection-${unavailable!.id}`) {
        throw new Error("Jobber is unavailable");
      }
      return JOBBER_USERS;
    });

    try {
      const list = await call("GET", "/team/jobber-members", { as: "owner" });
      expect(list.status).toBe(200);
      const roster = (await list.json()) as {
        members: Array<{ jobberUserId: string; gone: boolean }>;
        failedConnections: Array<{ id: number; name: string }>;
      };
      expect(roster.members.map((member) => member.jobberUserId)).toEqual(
        expect.arrayContaining([JU_GRETA, JU_MARCO, JU_ZED]),
      );
      expect(roster.members.some((member) => member.gone)).toBe(false);
      expect(roster.failedConnections).toEqual([
        { id: unavailable!.id, name: "Night crew" },
      ]);

      const link = await call("POST", `/team/${cleanerSeatId}/jobber-link`, {
        as: "owner",
        body: { jobberUserId: JU_ZED },
      });
      expect(link.status).toBe(409);
      expect((await link.json()).error).toContain("Night crew");

      const importUser = await call("POST", "/team/jobber-members/import", {
        as: "owner",
        body: { jobberUserId: JU_ZED },
      });
      expect(importUser.status).toBe(409);
      expect((await importUser.json()).error).toContain("Night crew");
    } finally {
      await db
        .delete(jobberConnectionsTable)
        .where(eq(jobberConnectionsTable.companyId, companyId));
    }
  });
});

describe("linking", () => {
  it("is the owner's call alone", async () => {
    const res = await call("POST", `/team/${gretaId}/jobber-link`, {
      as: "dispatcher",
      body: { jobberUserId: JU_GRETA },
    });
    expect(res.status).toBe(403);
  });

  it("stores the link and the preview stops suggesting", async () => {
    const res = await call("POST", `/team/${gretaId}/jobber-link`, {
      as: "owner",
      body: { jobberUserId: JU_GRETA },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).jobberUserId).toBe(JU_GRETA);

    const rows = await jobberRows();
    expect(rows.get(JU_GRETA)).toMatchObject({
      linkedTeamMemberId: gretaId,
      suggestedTeamMemberId: null,
    });
  });

  it("refuses to put one Jobber user on two seats", async () => {
    const res = await call("POST", `/team/${cleanerSeatId}/jobber-link`, {
      as: "owner",
      body: { jobberUserId: JU_GRETA },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("Greta Holt");
  });

  it("refuses a seat that isn't in the company", async () => {
    const res = await call("POST", `/team/999999999/jobber-link`, {
      as: "owner",
      body: { jobberUserId: JU_ZED },
    });
    expect(res.status).toBe(404);
  });

  it("refuses an id Jobber doesn't vouch for", async () => {
    // A typo'd or deactivated id stored as a link would silently block name
    // fallback for that seat — so nothing unverified is ever stored.
    const res = await call("POST", `/team/${cleanerSeatId}/jobber-link`, {
      as: "owner",
      body: { jobberUserId: `ju_bogus_${runId}` },
    });
    expect(res.status).toBe(404);
    const rows = await jobberRows();
    expect(
      [...rows.values()].some((r) => r.linkedTeamMemberId === cleanerSeatId),
    ).toBe(false);
  });

  it("stores nothing when Jobber can't be reached to verify", async () => {
    listJobberUsersMock.mockRejectedValueOnce(new Error("boom"));
    const res = await call("POST", `/team/${cleanerSeatId}/jobber-link`, {
      as: "owner",
      body: { jobberUserId: JU_ZED },
    });
    expect(res.status).toBe(502);
    const rows = await jobberRows();
    expect(rows.get(JU_ZED)).toMatchObject({ linkedTeamMemberId: null });
  });

  it("waits for reauthorization instead of trusting a stale picture", async () => {
    await db
      .update(companiesTable)
      .set({ jobberNeedsReauth: true })
      .where(eq(companiesTable.id, companyId));
    try {
      const res = await call("POST", `/team/${cleanerSeatId}/jobber-link`, {
        as: "owner",
        body: { jobberUserId: JU_ZED },
      });
      expect(res.status).toBe(409);
    } finally {
      await db
        .update(companiesTable)
        .set({ jobberNeedsReauth: false })
        .where(eq(companiesTable.id, companyId));
    }
  });
});

describe("unlinking", () => {
  it("is the owner's call alone", async () => {
    const res = await call("DELETE", `/team/${gretaId}/jobber-link`, {
      as: "dispatcher",
    });
    expect(res.status).toBe(403);
  });

  it("clears the link and the name suggestion comes back", async () => {
    const res = await call("DELETE", `/team/${gretaId}/jobber-link`, {
      as: "owner",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).jobberUserId).toBeNull();

    // The preview immediately falls back to the name matcher — the same
    // fallback the next sync would use.
    const rows = await jobberRows();
    expect(rows.get(JU_GRETA)).toMatchObject({
      linkedTeamMemberId: null,
      suggestedTeamMemberId: gretaId,
    });
  });
});

describe("importing a Jobber user as staff", () => {
  it("is the owner's call alone", async () => {
    const res = await call("POST", "/team/jobber-members/import", {
      as: "dispatcher",
      body: { jobberUserId: JU_ZED },
    });
    expect(res.status).toBe(403);
  });

  it("creates a roster-only seat — no email, no login, already linked", async () => {
    const res = await call("POST", "/team/jobber-members/import", {
      as: "owner",
      body: { jobberUserId: JU_ZED },
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created).toMatchObject({
      name: "Zed Nobody",
      role: "cleaner",
      jobberUserId: JU_ZED,
      hasLogin: false,
      active: true,
    });
    expect(created.email).toBeFalsy();

    const rows = await jobberRows();
    expect(rows.get(JU_ZED)!.linkedTeamMemberId).toBe(created.id);
  });

  it("won't import the same Jobber user twice", async () => {
    const res = await call("POST", "/team/jobber-members/import", {
      as: "owner",
      body: { jobberUserId: JU_ZED },
    });
    expect(res.status).toBe(409);
  });

  it("only imports ids Jobber confirms are active users", async () => {
    const res = await call("POST", "/team/jobber-members/import", {
      as: "owner",
      body: { jobberUserId: `ju_bogus_${runId}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("when Jobber isn't connected", () => {
  beforeAll(async () => {
    await db
      .update(companiesTable)
      .set({ jobberConnected: false })
      .where(eq(companiesTable.id, companyId));
  });

  it("the list and both create paths refuse", async () => {
    const list = await call("GET", "/team/jobber-members", { as: "owner" });
    expect(list.status).toBe(400);
    const link = await call("POST", `/team/${gretaId}/jobber-link`, {
      as: "owner",
      body: { jobberUserId: JU_GRETA },
    });
    expect(link.status).toBe(400);
    const imp = await call("POST", "/team/jobber-members/import", {
      as: "owner",
      body: { jobberUserId: JU_ZED },
    });
    expect(imp.status).toBe(400);
  });

  it("unlink still works, so a wrong link is never stuck behind a dead connection", async () => {
    const res = await call("DELETE", `/team/${marcoId}/jobber-link`, {
      as: "owner",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).jobberUserId).toBeNull();
  });
});
