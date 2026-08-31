/**
 * The owner's quick verdict tags on calls and leads: set, change, clear,
 * reject junk values, and the company boundary — another company's rows are
 * invisible (404). Role rules live in authorization.test.ts.
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
import {
  db,
  pool,
  companiesTable,
  callsTable,
  leadsTable,
  clientsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const runId = `${Date.now()}_${process.pid}`;
const OWNER_A = `test_tags_owner_a_${runId}`;
const OWNER_B = `test_tags_owner_b_${runId}`;

let server: http.Server;
let baseUrl: string;
let companyAId: number;
let companyBId: number;
let callAId: number;
let leadAId: number;
let callBId: number;
let leadBId: number;
let clientAId: number;

async function patchTag(
  kind: "calls" | "leads",
  id: number,
  tag: string | null,
  asUser: string = OWNER_A,
): Promise<Response> {
  return fetch(`${baseUrl}/api/${kind}/${id}/tag`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-test-user": asUser,
    },
    body: JSON.stringify({ tag }),
  });
}

beforeAll(async () => {
  const [companyA] = await db
    .insert(companiesTable)
    .values({ ownerUserId: OWNER_A, name: `Tags Co A ${runId}` })
    .returning();
  const [companyB] = await db
    .insert(companiesTable)
    .values({ ownerUserId: OWNER_B, name: `Tags Co B ${runId}` })
    .returning();
  companyAId = companyA!.id;
  companyBId = companyB!.id;

  const [callA] = await db
    .insert(callsTable)
    .values({
      companyId: companyAId,
      callerName: "Tag Caller A",
      callerPhone: "+15550001111",
      status: "completed",
    })
    .returning();
  const [callB] = await db
    .insert(callsTable)
    .values({
      companyId: companyBId,
      callerName: "Tag Caller B",
      callerPhone: "+15550002222",
      status: "completed",
    })
    .returning();
  callAId = callA!.id;
  callBId = callB!.id;

  const [leadA] = await db
    .insert(leadsTable)
    .values({
      companyId: companyAId,
      source: "sheet",
      externalId: `tag_a_${runId}`,
      sourceTab: "Test Tab",
      firstName: "Tag",
      lastName: "LeadA",
    })
    .returning();
  const [leadB] = await db
    .insert(leadsTable)
    .values({
      companyId: companyBId,
      source: "sheet",
      externalId: `tag_b_${runId}`,
      sourceTab: "Test Tab",
      firstName: "Tag",
      lastName: "LeadB",
    })
    .returning();
  leadAId = leadA!.id;
  leadBId = leadB!.id;
  const [clientA] = await db
    .insert(clientsTable)
    .values({
      companyId: companyAId,
      name: "Tag Client A",
      phone: "(555) 000-1111",
      phoneE164: "+15550001111",
      source: "booking",
    })
    .returning();
  clientAId = clientA!.id;

  server = app.listen(0);
  await new Promise<void>((resolve) => server.on("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await db.delete(callsTable).where(inArray(callsTable.id, [callAId, callBId]));
  await db.delete(leadsTable).where(inArray(leadsTable.id, [leadAId, leadBId]));
  await db.delete(clientsTable).where(eq(clientsTable.id, clientAId));
  await db
    .delete(companiesTable)
    .where(inArray(companiesTable.id, [companyAId, companyBId]));
  await pool.end();
});

describe("PATCH /calls/:id/tag", () => {
  it("sets, changes, and clears the tag", async () => {
    let res = await patchTag("calls", callAId, "spam");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tag: string | null }).tag).toBe("spam");

    res = await patchTag("calls", callAId, "client");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tag: string | null }).tag).toBe("client");

    res = await patchTag("calls", callAId, null);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tag: string | null }).tag).toBe(null);
  });

  it("rejects a made-up tag value", async () => {
    const res = await patchTag("calls", callAId, "definitely_not_a_tag");
    expect(res.status).toBe(400);
  });

  it("can't reach another company's call", async () => {
    const res = await patchTag("calls", callBId, "spam");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /leads/:id/tag", () => {
  it("sets, changes, and clears the tag", async () => {
    let res = await patchTag("leads", leadAId, "good_lead");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tag: string | null }).tag).toBe(
      "good_lead",
    );

    res = await patchTag("leads", leadAId, "bad_lead");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tag: string | null }).tag).toBe("bad_lead");

    res = await patchTag("leads", leadAId, null);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tag: string | null }).tag).toBe(null);
  });

  it("rejects a made-up tag value", async () => {
    const res = await patchTag("leads", leadAId, "vip");
    expect(res.status).toBe(400);
  });

  it("can't reach another company's lead", async () => {
    const res = await patchTag("leads", leadBId, "spam");
    expect(res.status).toBe(404);
  });

  it("the saved tag comes back in the leads list", async () => {
    await patchTag("leads", leadAId, "spam");
    const res = await fetch(`${baseUrl}/api/leads`, {
      headers: { "x-test-user": OWNER_A },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: number; tag: string | null }[];
    expect(rows.find((r) => r.id === leadAId)?.tag).toBe("spam");
  });
});

describe("PATCH /customer-tags/:kind/:id", () => {
  it("propagates a client verdict to the matching call", async () => {
    const res = await fetch(
      `${baseUrl}/api/customer-tags/client/${clientAId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-test-user": OWNER_A,
        },
        body: JSON.stringify({ tag: "spam" }),
      },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tag: string | null }).tag).toBe("spam");
    const [call] = await db
      .select({ tag: callsTable.tag })
      .from(callsTable)
      .where(eq(callsTable.id, callAId));
    expect(call?.tag).toBe("spam");
  });

  it("does not allow a different company's client", async () => {
    const res = await fetch(
      `${baseUrl}/api/customer-tags/client/${clientAId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-test-user": OWNER_B,
        },
        body: JSON.stringify({ tag: "spam" }),
      },
    );
    expect(res.status).toBe(404);
  });
});
