import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

import { companiesTable, db, pool } from "@workspace/db";
import { eq } from "drizzle-orm";
import { leadsCompanyId } from "./leadsSync";

const originalCompanyId = process.env.LEADS_COMPANY_ID;
const runId = `${Date.now()}_${process.pid}`;
let companyId: number;

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `leads_destination_owner_${runId}`,
      name: `Leads Destination ${runId}`,
    })
    .returning({ id: companiesTable.id });
  companyId = company!.id;
});

afterAll(async () => {
  if (originalCompanyId === undefined) {
    delete process.env.LEADS_COMPANY_ID;
  } else {
    process.env.LEADS_COMPANY_ID = originalCompanyId;
  }
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end();
});

describe("lead feed destination", () => {
  it("uses the explicitly configured company instead of insertion order", async () => {
    process.env.LEADS_COMPANY_ID = String(companyId);
    await expect(leadsCompanyId()).resolves.toBe(companyId);
  });

  it("fails closed when the configured company id is invalid", async () => {
    process.env.LEADS_COMPANY_ID = "not-a-company";
    await expect(leadsCompanyId()).resolves.toBeNull();
  });
});
