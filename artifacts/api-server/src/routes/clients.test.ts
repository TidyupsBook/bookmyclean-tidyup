import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { once } from "node:events";
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
        emailAddresses: [],
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
import { clientsTable, companiesTable, db, pool } from "@workspace/db";
import { eq } from "drizzle-orm";

const runId = `${Date.now()}_${process.pid}`;
const ownerId = `clients_owner_${runId}`;
const phone = `+1780${String(Date.now()).slice(-7)}`;
let companyId: number;
let clientId: number;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: ownerId,
      name: `Clients Route Co ${runId}`,
      timezone: "America/Edmonton",
    })
    .returning();
  companyId = company!.id;
  const [client] = await db
    .insert(clientsTable)
    .values({
      companyId,
      name: "Original Customer",
      phone,
      phoneE164: phone,
      email: "original@example.com",
      streetAddress: "10 Original Ave",
      city: "Edmonton",
      province: "AB",
      postalCode: "T5J 0N3",
      source: "jobber",
    })
    .returning();
  clientId = client!.id;

  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await db.delete(clientsTable).where(eq(clientsTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end();
});

async function request(method: string, path: string, body: object) {
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-test-user": ownerId,
    },
    body: JSON.stringify(body),
  });
}

describe("client directory writes", () => {
  it("rejects a duplicate phone without overwriting existing contact details", async () => {
    const response = await request("POST", "/clients", {
      name: "Wrong Replacement",
      phone,
    });
    expect(response.status).toBe(409);

    const [saved] = await db
      .select()
      .from(clientsTable)
      .where(eq(clientsTable.id, clientId));
    expect(saved).toMatchObject({
      name: "Original Customer",
      email: "original@example.com",
      streetAddress: "10 Original Ave",
      city: "Edmonton",
      province: "AB",
      postalCode: "T5J 0N3",
    });
  });

  it("rejects an empty edit", async () => {
    const response = await request("PATCH", `/clients/${clientId}`, {});
    expect(response.status).toBe(400);
  });
});
