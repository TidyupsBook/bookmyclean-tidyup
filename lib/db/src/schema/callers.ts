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
import { clientsTable } from "./clients";

/** A phone-number based, company-private directory built from real calls. */
export const callersTable = pgTable(
  "callers",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    phone: text("phone").notNull(),
    phoneE164: text("phone_e164").notNull(),
    bestName: text("best_name").notNull(),
    firstCallAt: timestamp("first_call_at", { withTimezone: true }).notNull(),
    latestCallAt: timestamp("latest_call_at", { withTimezone: true }).notNull(),
    callCount: integer("call_count").notNull().default(0),
    clientId: integer("client_id").references(() => clientsTable.id, {
      onDelete: "set null",
    }),
    quoContactId: text("quo_contact_id"),
    quoSyncedAt: timestamp("quo_synced_at", { withTimezone: true }),
    quoSyncError: text("quo_sync_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("callers_company_phone_e164_uq").on(
      table.companyId,
      table.phoneE164,
    ),
    index("callers_company_latest_call_idx").on(
      table.companyId,
      table.latestCallAt,
    ),
  ],
);

export const insertCallerSchema = createInsertSchema(callersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCaller = z.infer<typeof insertCallerSchema>;
export type Caller = typeof callersTable.$inferSelect;
