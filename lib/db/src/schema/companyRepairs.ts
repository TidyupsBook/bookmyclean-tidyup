import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

/**
 * Immutable evidence for exceptional, owner-approved destructive repairs.
 * It intentionally has no company foreign key: the audit must survive removal
 * of the companies named in its before/after snapshots.
 */
export const companyRepairAuditsTable = pgTable("company_repair_audits", {
  id: serial("id").primaryKey(),
  repairKey: text("repair_key").notNull().unique(),
  performedBy: text("performed_by").notNull(),
  reviewDigest: text("review_digest").notNull(),
  targetCompanyIds: integer("target_company_ids").array().notNull(),
  beforeSnapshot: jsonb("before_snapshot").notNull(),
  afterSnapshot: jsonb("after_snapshot").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type CompanyRepairAuditRecord =
  typeof companyRepairAuditsTable.$inferSelect;
