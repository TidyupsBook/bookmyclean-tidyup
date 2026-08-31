import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { callersTable } from "./callers";

export type TranscriptSegment = {
  speaker: "caller" | "ai";
  text: string;
  offsetSeconds: number;
};

export type ExtractedAnswer = { field: string; value: string };

export const callsTable = pgTable(
  "calls",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    callerName: text("caller_name").notNull(),
    callerPhone: text("caller_phone").notNull(),
    callerId: integer("caller_id").references(() => callersTable.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull(), // in_progress | completed | missed | booked
    serviceRequested: text("service_requested"),
    preferredTime: text("preferred_time"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    isTest: boolean("is_test").notNull().default(false),
    transcript: jsonb("transcript")
      .$type<TranscriptSegment[]>()
      .notNull()
      .default([]),
    extractedAnswers: jsonb("extracted_answers")
      .$type<ExtractedAnswer[]>()
      .notNull()
      .default([]),
    bookingId: integer("booking_id"),
    quoCallId: text("quo_call_id").unique(),
    quoPhoneNumberId: text("quo_phone_number_id"),
    direction: text("direction"), // incoming | outgoing
    summary: text("summary"),
    recordingUrl: text("recording_url"),
    notes: text("notes"),
    // The owner's quick verdict after the call. Null until tagged; separate
    // from the operational `status` on purpose — a booked call can still turn
    // out to be a scammer. A DB CHECK constraint pins the same four values.
    tag: text("tag", { enum: ["client", "good_lead", "bad_lead", "spam"] }),
  },
  (table) => [
    // The dashboard and recent-call views filter by company and a started_at
    // window; without this index those queries scan every call ever taken.
    index("calls_company_started_at_idx").on(table.companyId, table.startedAt),
  ],
);

export const insertCallSchema = createInsertSchema(callsTable).omit({
  id: true,
});
export type InsertCall = z.infer<typeof insertCallSchema>;
export type Call = typeof callsTable.$inferSelect;
