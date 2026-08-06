/**
 * One-time-style cleanup of owner phone numbers saved before PATCH /api/company
 * validated them.
 *
 * A number stored as "555 123 4567" still works once normalized to E.164; one
 * stored as "555-12" can never receive an outage text and would fail silently
 * exactly when the owner most needs it. This pass, run at startup after
 * migrations, normalizes what it can in place and, for values that cannot be
 * read as a phone number, clears the live column and preserves the raw value
 * in the matching `...Rejected` column so settings can warn the owner.
 *
 * Idempotent and cheap: already-valid E.164 values are left untouched, so
 * repeat runs on every boot are no-ops.
 */
import { eq } from "drizzle-orm";
import { db, companiesTable } from "@workspace/db";
import { toE164 } from "./quo";
import { logger } from "./logger";

const FIELDS = [
  {
    live: "ringThroughNumber",
    rejected: "ringThroughNumberRejected",
  },
  {
    live: "notificationNumber",
    rejected: "notificationNumberRejected",
  },
] as const;

export async function cleanupStoredPhoneNumbers(): Promise<void> {
  const companies = await db.select().from(companiesTable);
  for (const company of companies) {
    const patch: Record<string, string | null> = {};
    for (const { live, rejected } of FIELDS) {
      const raw = company[live];
      if (!raw || raw.trim() === "") continue;
      const normalized = toE164(raw);
      if (normalized === raw) continue; // already clean
      if (normalized) {
        patch[live] = normalized;
      } else {
        // Undialable: clear it so sends fail loudly at the "no number
        // configured" check, and keep the raw value for the settings warning.
        patch[live] = null;
        patch[rejected] = raw;
      }
    }
    if (Object.keys(patch).length === 0) continue;
    await db
      .update(companiesTable)
      .set(patch)
      .where(eq(companiesTable.id, company.id));
    logger.warn(
      { companyId: company.id, patch },
      "Cleaned up stored owner phone number(s) that predate validation",
    );
  }
}
