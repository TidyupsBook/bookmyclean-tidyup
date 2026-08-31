import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { companiesTable, db } from "@workspace/db";
import {
  CompanyRepairGuardError,
  getCompanyRepairAudit,
  LIVE_COMPANY_REPAIR_FINGERPRINT,
  lockCompanyRepairTables,
  repairTestCompaniesInTransaction,
  TEST_COMPANY_REPAIR_TARGETS,
} from "./companyRepair";

const ROLLBACK = new Error("rollback company repair test");

async function alignProtectedCompany(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
) {
  await tx
    .update(companiesTable)
    .set({
      ownerUserId: LIVE_COMPANY_REPAIR_FINGERPRINT.ownerUserId,
      ownerEmail: LIVE_COMPANY_REPAIR_FINGERPRINT.ownerEmail,
      name: LIVE_COMPANY_REPAIR_FINGERPRINT.name,
      jobberConnected: LIVE_COMPANY_REPAIR_FINGERPRINT.jobberConnected,
      jobberAccountId: LIVE_COMPANY_REPAIR_FINGERPRINT.jobberAccountId,
    })
    .where(eq(companiesTable.id, LIVE_COMPANY_REPAIR_FINGERPRINT.id));
}

describe("company test-data repair", () => {
  it("rejects a reference crossing from the protected company into a target", async () => {
    await expect(
      db.transaction(async (tx) => {
        await lockCompanyRepairTables(tx);
        await alignProtectedCompany(tx);
        await tx.execute(sql`
          UPDATE callers
          SET client_id = (
            SELECT id FROM clients WHERE company_id = 6 ORDER BY id LIMIT 1
          )
          WHERE id = (
            SELECT id FROM callers WHERE company_id = 7 ORDER BY id LIMIT 1
          )
        `);
        await tx.execute(sql`
          UPDATE team_members
          SET jobber_connection_id = (
            SELECT id
            FROM jobber_connections
            WHERE company_id = 6734
            ORDER BY id
            LIMIT 1
          )
          WHERE id = (
            SELECT id
            FROM team_members
            WHERE company_id = 7
            ORDER BY id
            LIMIT 1
          )
        `);

        const audit = await getCompanyRepairAudit(tx);
        expect(audit.crossCompanyReferences).toContainEqual({
          edge: "callers.client_id",
          count: 1,
        });
        expect(audit.crossCompanyReferences).toContainEqual({
          edge: "team_members.jobber_connection_id",
          count: 1,
        });
        await expect(
          repairTestCompaniesInTransaction(
            tx,
            LIVE_COMPANY_REPAIR_FINGERPRINT.ownerUserId,
            audit.reviewDigest,
            audit.candidateCompanyIds,
          ),
        ).rejects.toThrow(/cross-company reference/);
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  });

  it("requires the reviewed digest and leaves the protected live company unchanged", async () => {
    let completed = false;

    await expect(
      db.transaction(async (tx) => {
        await lockCompanyRepairTables(tx);
        // Production and development were copied from the same original
        // fixture set, but the protected owner's Clerk id differs by
        // environment. Make this transaction look exactly like the reviewed
        // production snapshot; the forced rollback below restores it.
        await alignProtectedCompany(tx);
        // Exercise the non-cascading staff -> Jobber connection dependency.
        // Both companies are reviewed targets, so this is safe to delete but
        // only when staff rows are removed before connection rows.
        await tx.execute(sql`
          UPDATE team_members
          SET jobber_connection_id = (
            SELECT id
            FROM jobber_connections
            WHERE company_id = 6734
            ORDER BY id
            LIMIT 1
          )
          WHERE id = (
            SELECT id
            FROM team_members
            WHERE company_id = 5872
            ORDER BY id
            LIMIT 1
          )
        `);

        const audit = await getCompanyRepairAudit(tx);
        expect(audit.candidateCompanyIds).toEqual(
          TEST_COMPANY_REPAIR_TARGETS.map((candidate) => candidate.id).sort(
            (a, b) => a - b,
          ),
        );

        await expect(
          repairTestCompaniesInTransaction(
            tx,
            LIVE_COMPANY_REPAIR_FINGERPRINT.ownerUserId,
            "0".repeat(64),
            audit.candidateCompanyIds,
          ),
        ).rejects.toThrow(CompanyRepairGuardError);

        const afterRejectedReview = await getCompanyRepairAudit(tx);
        expect(afterRejectedReview.candidateCompanyIds).toEqual(
          audit.candidateCompanyIds,
        );

        const result = await repairTestCompaniesInTransaction(
          tx,
          LIVE_COMPANY_REPAIR_FINGERPRINT.ownerUserId,
          afterRejectedReview.reviewDigest,
          afterRejectedReview.candidateCompanyIds,
        );

        expect(result.deletedCompanyIds).toEqual(audit.candidateCompanyIds);
        expect(result.after.candidateCompanyIds).toEqual([]);
        expect(
          result.after.companies.find(
            (company) => company.id === LIVE_COMPANY_REPAIR_FINGERPRINT.id,
          ),
        ).toEqual(
          result.before.companies.find(
            (company) => company.id === LIVE_COMPANY_REPAIR_FINGERPRINT.id,
          ),
        );
        const auditRecords = await tx.execute(sql`
          SELECT
            id,
            performed_by AS "performedBy",
            review_digest AS "reviewDigest",
            target_company_ids AS "targetCompanyIds"
          FROM company_repair_audits
          WHERE repair_key = 'remove-stale-test-companies-2026-08'
        `);
        const auditRecord = auditRecords.rows[0];
        expect(auditRecord).toMatchObject({
          id: result.auditId,
          performedBy: LIVE_COMPANY_REPAIR_FINGERPRINT.ownerUserId,
          reviewDigest: result.reviewDigest,
          targetCompanyIds: result.deletedCompanyIds,
        });
        completed = true;
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);

    expect(completed).toBe(true);
  }, 120_000);
});
