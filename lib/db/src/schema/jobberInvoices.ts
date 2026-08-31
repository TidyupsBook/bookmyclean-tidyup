import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

/**
 * Invoices created in Jobber, mirrored here read-only so the dashboard can
 * answer "has this client paid?" without opening Jobber.
 *
 * Same contract as the quote mirror next door: rows are only ever written by
 * the Jobber invoice sync, keyed by (company, jobberInvoiceId) so re-pulls
 * update in place. Payments happen inside Jobber — nothing on this side
 * writes back, and the deep link is the way to edit or collect.
 *
 * Money is stored in cents (Jobber returns float dollars) — never floats in
 * the database, and the UI formats from cents. `balanceCents` is what is
 * still owing; Jobber zeroes it as payments land, which is exactly the
 * paid-vs-pending answer the page exists for.
 */
export const jobberInvoicesTable = pgTable(
  "jobber_invoices",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      // Cascade: the mirror is derived from Jobber — a deleted company must
      // not be pinned in place by its own invoice mirror.
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    jobberInvoiceId: text("jobber_invoice_id").notNull(),
    // Jobber's invoice number is a string in their API (may carry prefixes).
    invoiceNumber: text("invoice_number"),
    subject: text("subject"),
    clientName: text("client_name"),
    clientPhone: text("client_phone"),
    tag: text("tag"),
    jobberClientId: text("jobber_client_id"),
    propertyAddress: text("property_address"),
    // Jobber's InvoiceStatusTypeEnum, verbatim: draft | awaiting_payment |
    // paid | past_due | bad_debt | sent_not_due. Stored as text so a new
    // Jobber status never breaks the sync; the UI maps unknown values to a
    // neutral badge.
    status: text("status").notNull(),
    totalCents: integer("total_cents"),
    // What is still owing. Zero on a paid invoice; the UI derives nothing
    // from status alone because Jobber can mark paid-but-nonzero edge cases.
    balanceCents: integer("balance_cents"),
    // Deep link into Jobber's own invoice page.
    jobberWebUri: text("jobber_web_uri"),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    jobberCreatedAt: timestamp("jobber_created_at", { withTimezone: true }),
    jobberUpdatedAt: timestamp("jobber_updated_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("jobber_invoices_company_invoice_uq").on(
      table.companyId,
      table.jobberInvoiceId,
    ),
    index("jobber_invoices_company_idx").on(table.companyId),
  ],
);

export const insertJobberInvoiceSchema = createInsertSchema(
  jobberInvoicesTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertJobberInvoice = z.infer<typeof insertJobberInvoiceSchema>;
export type JobberInvoiceRow = typeof jobberInvoicesTable.$inferSelect;
