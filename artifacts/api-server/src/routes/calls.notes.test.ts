/**
 * The per-call notepad: saving, editing, clearing, and the boundaries —
 * another company's call is invisible (404) and an absurdly long paste is
 * rejected before touching the row. Role rules live in authorization.test.ts.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import type { AddressInfo } from "node:net";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

// Auth is the only thing mocked: the user id comes from a test header.
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
import { db, pool, companiesTable, callsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

const runId = `${Date.now()}_${process.pid}`;
const OWNER_A = `test_callnotes_owner_a_${runId}`;
const OWNER_B = `test_callnotes_owner_b_${runId}`;

let server: http.Server;
let baseUrl: string;
let companyAId: number;
let companyBId: number;
let callAId: number;
let callBId: number;

async function patchNotes(
  callId: number,
  notes: string,
  asUser: string = OWNER_A,
): Promise<Response> {
  return fetch(`${baseUrl}/api/calls/${callId}/notes`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-test-user": asUser,
    },
    body: JSON.stringify({ notes }),
  });
}

beforeAll(async () => {
  const [companyA] = await db
    .insert(companiesTable)
    .values({ ownerUserId: OWNER_A, name: `Call Notes Co A ${runId}` })
    .returning();
  const [companyB] = await db
    .insert(companiesTable)
    .values({ ownerUserId: OWNER_B, name: `Call Notes Co B ${runId}` })
    .returning();
  companyAId = companyA!.id;
  companyBId = companyB!.id;

  const calls = await db
    .insert(callsTable)
    .values([
      {
        companyId: companyAId,
        callerName: "Notes Caller",
        callerPhone: "+15550001001",
        status: "completed",
      },
      {
        companyId: companyBId,
        callerName: "Other Co Caller",
        callerPhone: "+15550001002",
        status: "completed",
      },
    ])
    .returning();
  callAId = calls[0]!.id;
  callBId = calls[1]!.id;

  server = app.listen(0);
  await new Promise<void>((resolve) =>
    server.once("listening", () => resolve()),
  );
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.delete(callsTable).where(inArray(callsTable.id, [callAId, callBId]));
  await db
    .delete(companiesTable)
    .where(inArray(companiesTable.id, [companyAId, companyBId]));
  await pool.end();
});

describe("PATCH /calls/:id/notes", () => {
  it("saves the pad and returns it on the call detail", async () => {
    const res = await patchNotes(callAId, "Wants Tuesdays. Has two dogs.");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notes: string | null };
    expect(body.notes).toBe("Wants Tuesdays. Has two dogs.");

    const detail = await fetch(`${baseUrl}/api/calls/${callAId}`, {
      headers: { "x-test-user": OWNER_A },
    });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { notes: string | null };
    expect(detailBody.notes).toBe("Wants Tuesdays. Has two dogs.");
  });

  it("overwrites on a second save", async () => {
    await patchNotes(callAId, "First draft");
    const res = await patchNotes(callAId, "Second draft");
    const body = (await res.json()) as { notes: string | null };
    expect(body.notes).toBe("Second draft");
  });

  it("an empty string clears the pad", async () => {
    await patchNotes(callAId, "Something");
    const res = await patchNotes(callAId, "");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notes: string | null };
    expect(body.notes).toBe("");
  });

  it("another company's call is a plain 404, and the row is untouched", async () => {
    const res = await patchNotes(callBId, "Should never land");
    expect(res.status).toBe(404);

    const [row] = await db
      .select()
      .from(callsTable)
      .where(inArray(callsTable.id, [callBId]));
    expect(row!.notes).toBeNull();
  });

  it("a nonexistent call is 404", async () => {
    const res = await patchNotes(999999999, "ghost");
    expect(res.status).toBe(404);
  });

  it("rejects a paste beyond the cap without saving", async () => {
    await patchNotes(callAId, "keep me");
    const res = await patchNotes(callAId, "x".repeat(20001));
    expect(res.status).toBe(400);

    const [row] = await db
      .select()
      .from(callsTable)
      .where(inArray(callsTable.id, [callAId]));
    expect(row!.notes).toBe("keep me");
  });
});
