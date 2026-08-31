import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

/**
 * The company's own client directory: one row per customer, deduplicated
 * across every place a customer appears (bookings, Jobber imports, Jobber
 * quotes, converted leads).
 *
 * Dedup keys, in precedence order:
 *  1. `jobberClientId` — Jobber's id is the strongest identity when present.
 *  2. `phoneE164` — the normalized phone, since phone is how this product
 *     identifies people everywhere else (threads, calls, Jobber matching).
 *
 * `phone` keeps the number exactly as it was typed or received (roster-style
 * values are stored as typed elsewhere too); `phoneE164` exists purely for
 * dedup and digit search, following the leads table's convention.
 *
 * Contact fields are filled, never blanked: a later sighting of the same
 * customer with fewer details (e.g. a Jobber visit with only a name) must not
 * erase the email or address captured at booking time.
 */
export const clientsTable = pgTable(
  "clients",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      // Cascade: the directory is derived bookkeeping — a deleted company
      // must not be pinned in place by its own client index.
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    phone: text("phone"),
    phoneE164: text("phone_e164"),
    tag: text("tag"),
    email: text("email"),
    streetAddress: text("street_address"),
    city: text("city"),
    province: text("province"),
    postalCode: text("postal_code"),
    jobberClientId: text("jobber_client_id"),
    // Quo's contact identity and mirror health. Local client edits remain
    // authoritative when its API is unavailable.
    quoContactId: text("quo_contact_id"),
    quoSyncedAt: timestamp("quo_synced_at", { withTimezone: true }),
    quoSyncError: text("quo_sync_error"),
    // Where this customer was first seen: booking | jobber | lead.
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Partial: rows without a normalized phone (rare — e.g. a Jobber quote
    // client with no number on file) can't collide on NULL.
    uniqueIndex("clients_company_phone_e164_uq")
      .on(table.companyId, table.phoneE164)
      .where(sql`${table.phoneE164} IS NOT NULL`),
    uniqueIndex("clients_company_jobber_client_uq")
      .on(table.companyId, table.jobberClientId)
      .where(sql`${table.jobberClientId} IS NOT NULL`),
    index("clients_company_idx").on(table.companyId),
  ],
);

export const insertClientSchema = createInsertSchema(clientsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertClient = z.infer<typeof insertClientSchema>;
export type Client = typeof clientsTable.$inferSelect;
