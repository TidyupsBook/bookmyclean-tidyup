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
import { companiesTable, db, pool, servicesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const runId = `${Date.now()}_${process.pid}`;
const ownerId = `service_catalog_owner_${runId}`;
let companyId: number;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: ownerId,
      name: `Service Catalog Co ${runId}`,
      timezone: "America/Edmonton",
    })
    .returning();
  companyId = company!.id;
  await db.insert(servicesTable).values({
    companyId,
    name: "standard home cleaning",
    description: "Keep this owner-written description.",
    priceMin: 175,
    priceMax: 175,
  });

  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await db.delete(servicesTable).where(eq(servicesTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end();
});

async function importCatalog() {
  return fetch(`${baseUrl}/api/services/suggested-catalog`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-user": ownerId,
    },
  });
}

describe("suggested service catalog", () => {
  it("adds the 20 names once, preserves an existing service, and leaves unknown prices blank", async () => {
    const [first, concurrent] = await Promise.all([
      importCatalog(),
      importCatalog(),
    ]);
    expect(first.status).toBe(200);
    expect(concurrent.status).toBe(200);

    const rows = await db
      .select()
      .from(servicesTable)
      .where(eq(servicesTable.companyId, companyId));
    expect(rows).toHaveLength(20);
    expect(
      rows.find((row) => row.name === "standard home cleaning"),
    ).toMatchObject({
      description: "Keep this owner-written description.",
      priceMin: 175,
      priceMax: 175,
    });
    expect(
      rows.find((row) => row.name === "2Bed 2Bath Moveout Cleaning"),
    ).toMatchObject({ priceMin: 105, priceMax: 105 });
    expect(
      rows.find((row) => row.name === "3Bed 3Bath Moveout Cleaning"),
    ).toMatchObject({ priceMin: 105, priceMax: 105 });
    expect(rows.find((row) => row.name === "Steam Cleaning")).toMatchObject({
      priceMin: null,
      priceMax: null,
    });

    const again = await importCatalog();
    expect(again.status).toBe(200);
    const result = (await again.json()) as { created: number };
    expect(result.created).toBe(0);
  });
});
