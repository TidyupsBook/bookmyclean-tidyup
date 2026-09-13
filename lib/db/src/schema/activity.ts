import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import type { PendingTextSource } from "./pendingTexts";

export const activityTable = pgTable("activity", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companiesTable.id),
  type: text("type").notNull(), // call_answered | booking_created | jobber_synced | quote_sent | test_call | team_invited | join_code_changed
  message: text("message").notNull(),
  /**
   * For call-related entries (call_answered, test_call): the calls row this
   * entry describes, so the mobile feed can deep-link to that call's detail
   * screen. Older rows predate the column and stay null — those simply are
   * not tappable.
   */
  callId: integer("call_id"),
  /**
   * For booking-related entries (booking_created, crew_assigned, job_started,
   * job_finished): the bookings row this entry describes, so the mobile feed
   * can deep-link to that booking's detail screen. Older rows predate the
   * column and stay null — those simply are not tappable.
   */
  bookingId: integer("booking_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /**
   * For "text_given_up" entries only: everything needed to re-queue the
   * dropped text if the owner asks for it. The pending_texts row is gone by
   * the time the owner sees the entry, so the payload lives here. Cleared
   * (conditional update = the claim) once a resend is requested, so one tap
   * queues exactly one text.
   */
  textPayload: jsonb("text_payload").$type<{
    toPhone: string | null;
    kind: string;
    content: string;
    source?: PendingTextSource | null;
  } | null>(),
});

export const insertActivitySchema = createInsertSchema(activityTable).omit({
  id: true,
  occurredAt: true,
});
export type InsertActivity = z.infer<typeof insertActivitySchema>;
export type Activity = typeof activityTable.$inferSelect;
