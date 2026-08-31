import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

/**
 * Every accepted Jobber webhook delivery this app has processed, keyed by a
 * stable identity built from the event (`topic:accountId:itemId:occurredAt`
 * — Jobber sends no delivery id of its own). A unique insert here is the
 * claim that makes processing idempotent, mirroring the Quo webhook: a
 * replayed or retried delivery collides and is acknowledged without being
 * handled twice. The claim is taken BEFORE any work and released again if
 * that work fails, so Jobber's retry gets a clean second attempt —
 * acknowledging first and processing afterwards silently drops events.
 *
 * `completedAt` is the backstop for the release itself failing: a claim that
 * never completed and has gone stale can be taken over by a later retry, so
 * a delivery can never be locked out forever behind a half-dead claim.
 */
export const jobberDeliveriesTable = pgTable("jobber_webhook_deliveries", {
  id: serial("id").primaryKey(),
  deliveryId: text("delivery_id").notNull().unique(),
  topic: text("topic").notNull(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companiesTable.id),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** Set once processing finished; NULL past the stale cutoff = re-claimable. */
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export type JobberDelivery = typeof jobberDeliveriesTable.$inferSelect;
