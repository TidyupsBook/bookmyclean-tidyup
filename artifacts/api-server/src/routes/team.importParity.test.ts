/**
 * The server half of the import-parity contract.
 *
 * `staffImportParityFixtures.ts` states the matching rule as data; this suite
 * runs every fixture case through the LIVE `/team/import` endpoint (real app,
 * real database, Clerk mocked) and checks that each row lands exactly as the
 * fixture promises: created, updating the named member, or skipped as an
 * in-paste repeat.
 *
 * The web app's `staffImportPreview.parity.test.ts` runs the SAME cases
 * through the Paste List preview. If either copy of the rule drifts, its
 * suite fails on the same named case.
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
  teamMembersTable,
  activityTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  IMPORT_PARITY_CASES,
  type ParityCase,
} from "../lib/staffImportParityFixtures";

const runId = `${Date.now()}_${process.pid}`;

/**
 * Fixture emails are placeholders; the tests share one dev database, so each
 * run gets its own addresses. The marker goes into the local part so the
 * case-folding the fixtures exercise is preserved verbatim.
 */
function uniqueEmail(email: string | null): string | null {
  return email === null ? null : email.replace("@", `+${runId}@`);
}

/** Each imported row carries a unique phone so we can find where it landed. */
function markerPhone(caseIndex: number, rowIndex: number): string {
  return `555-9${caseIndex}${rowIndex}`;
}

let server: http.Server;
let baseUrl: string;
const companyIds: number[] = [];

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  if (companyIds.length > 0) {
    await db
      .delete(activityTable)
      .where(inArray(activityTable.companyId, companyIds));
    await db
      .delete(teamMembersTable)
      .where(inArray(teamMembersTable.companyId, companyIds));
    await db
      .delete(companiesTable)
      .where(inArray(companiesTable.id, companyIds));
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

/**
 * Each case gets its own company so one case's roster can never bleed into
 * another's name-uniqueness counting.
 */
async function runCase(fixture: ParityCase, caseIndex: number) {
  const owner = `parity_owner_${runId}_${caseIndex}`;
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: owner,
      name: `Parity Co ${runId} ${caseIndex}`,
      timezone: "America/Toronto",
    })
    .returning();
  companyIds.push(company!.id);

  // Seed the pre-existing roster, remembering which db row each fixture
  // member key refers to.
  const memberIds = new Map<string, number>();
  for (const member of fixture.roster) {
    const [row] = await db
      .insert(teamMembersTable)
      .values({
        companyId: company!.id,
        name: member.name,
        email: uniqueEmail(member.email),
        role: "cleaner",
        status: "active",
      })
      .returning({ id: teamMembersTable.id });
    memberIds.set(member.key, row!.id);
  }
  const seededIds = new Set(memberIds.values());

  const res = await fetch(`${baseUrl}/api/team/import`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": owner },
    body: JSON.stringify({
      members: fixture.rows.map((row, rowIndex) => ({
        name: row.name,
        email: uniqueEmail(row.email),
        phone: markerPhone(caseIndex, rowIndex),
        role: "cleaner",
      })),
    }),
  });
  expect(res.status, `${fixture.title}: import request failed`).toBe(200);
  const result = (await res.json()) as {
    added: number;
    updated: number;
    skipped: number;
  };

  const expectedCounts = {
    added: fixture.rows.filter((r) => r.expected.kind === "new").length,
    updated: fixture.rows.filter((r) => r.expected.kind === "update").length,
    // The server reports both in-paste repeats and refused blank-name rows
    // as "skipped" — the errors array is what tells them apart.
    skipped: fixture.rows.filter(
      (r) => r.expected.kind === "duplicate" || r.expected.kind === "invalid",
    ).length,
  };
  expect(
    { added: result.added, updated: result.updated, skipped: result.skipped },
    `${fixture.title}: the server's added/updated/skipped counts differ from what the fixtures (and therefore the paste preview) promise`,
  ).toEqual(expectedCounts);

  const after = await db
    .select()
    .from(teamMembersTable)
    .where(eq(teamMembersTable.companyId, company!.id));

  for (const [rowIndex, row] of fixture.rows.entries()) {
    const marker = markerPhone(caseIndex, rowIndex);
    const landedOn = after.filter((m) => m.phone === marker);
    const label = `${fixture.title}: row ${rowIndex + 1} ("${row.name.trim()}")`;

    switch (row.expected.kind) {
      case "new": {
        expect(
          landedOn.map((m) => m.id),
          `${label} should have CREATED a member, but its phone marker landed elsewhere`,
        ).toHaveLength(1);
        expect(
          seededIds.has(landedOn[0]!.id),
          `${label} should have created a NEW member, but it overwrote an existing one — the preview would have said "New" while the server updated someone`,
        ).toBe(false);
        break;
      }
      case "update": {
        const targetId = memberIds.get(row.expected.memberKey)!;
        expect(
          landedOn.map((m) => m.id),
          `${label} should have UPDATED "${row.expected.memberKey}" (member ${targetId}) — the preview promises "Updates <name>" here`,
        ).toEqual([targetId]);
        break;
      }
      case "duplicate": {
        expect(
          landedOn,
          `${label} should have been SKIPPED as an in-paste repeat, but the server applied it`,
        ).toHaveLength(0);
        break;
      }
      case "invalid": {
        expect(
          landedOn,
          `${label} should have been REFUSED (blank name), but the server applied it`,
        ).toHaveLength(0);
        break;
      }
    }
  }
}

describe("import parity: the server matches rows exactly as the fixtures promise", () => {
  for (const [caseIndex, fixture] of IMPORT_PARITY_CASES.entries()) {
    it(fixture.title, async () => {
      await runCase(fixture, caseIndex);
    });
  }
});
