import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

/**
 * Webhooks registered with Quo on the company's behalf. `signingKey` is the
 * `whsec_...` value Quo returns at creation time and is required to verify
 * inbound deliveries.
 */
export const quoWebhooksTable = pgTable("quo_webhooks", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companiesTable.id),
  quoWebhookId: text("quo_webhook_id").notNull().unique(),
  signingKey: text("signing_key").notNull(),
  events: text("events").array().notNull().default([]),
  url: text("url").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertQuoWebhookSchema = createInsertSchema(quoWebhooksTable).omit(
  { id: true, createdAt: true },
);
export type InsertQuoWebhook = z.infer<typeof insertQuoWebhookSchema>;
export type QuoWebhook = typeof quoWebhooksTable.$inferSelect;

/**
 * Every accepted delivery, keyed by Quo's `webhook-id`. A unique insert here is
 * what makes processing idempotent: a replayed or retried delivery collides and
 * is acknowledged without being handled twice.
 */
export const quoDeliveriesTable = pgTable("quo_webhook_deliveries", {
  id: serial("id").primaryKey(),
  deliveryId: text("delivery_id").notNull().unique(),
  eventType: text("event_type").notNull(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companiesTable.id),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type QuoDelivery = typeof quoDeliveriesTable.$inferSelect;
