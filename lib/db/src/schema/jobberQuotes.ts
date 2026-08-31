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
 * Quotes created in Jobber, mirrored here read-only so the dashboard can show
 * where each one stands (draft / awaiting response / approved / converted…)
 * without opening Jobber.
 *
 * This is a mirror, not a second source of truth: rows are only ever written
 * by the Jobber quote sync, keyed by (company, jobberQuoteId) so re-pulls
 * update in place. The app's own in-call quotes live on bookings and are a
 * separate thing — a quote the owner writes inside Jobber never becomes a
 * booking row here.
 *
 * `jobberUpdatedAt` doubles as the sync watermark: each pull asks Jobber for
 * quotes updated since MAX(jobberUpdatedAt) (minus a small overlap), so steady
 * state costs one tiny page per cycle instead of re-reading history.
 *
 * Money is stored in cents (Jobber returns float dollars) — never floats in
 * the database, and the UI formats from cents.
 */
export const jobberQuotesTable = pgTable(
  "jobber_quotes",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      // Cascade: the mirror is derived from Jobber — a deleted company must
      // not be pinned in place by its own quote mirror.
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    jobberQuoteId: text("jobber_quote_id").notNull(),
    quoteNumber: integer("quote_number"),
    title: text("title"),
    clientName: text("client_name"),
    clientPhone: text("client_phone"),
    jobberClientId: text("jobber_client_id"),
    propertyAddress: text("property_address"),
    // Jobber's QuoteStatusTypeEnum, verbatim: draft | awaiting_response |
    // changes_requested | approved | converted | archived. Stored as text so
    // a new Jobber status never breaks the sync; the UI maps unknown values
    // to a neutral badge.
    status: text("status").notNull(),
    totalCents: integer("total_cents"),
    // Deep link into Jobber's own quote page.
    jobberWebUri: text("jobber_web_uri"),
    jobberCreatedAt: timestamp("jobber_created_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    transitionedAt: timestamp("transitioned_at", { withTimezone: true }),
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
    uniqueIndex("jobber_quotes_company_quote_uq").on(
      table.companyId,
      table.jobberQuoteId,
    ),
    index("jobber_quotes_company_idx").on(table.companyId),
  ],
);

export const insertJobberQuoteSchema = createInsertSchema(
  jobberQuotesTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertJobberQuote = z.infer<typeof insertJobberQuoteSchema>;
export type JobberQuoteRow = typeof jobberQuotesTable.$inferSelect;
