import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

export type TranscriptSegment = {
  speaker: "caller" | "ai";
  text: string;
  offsetSeconds: number;
};

export type ExtractedAnswer = { field: string; value: string };

export const callsTable = pgTable("calls", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companiesTable.id),
  callerName: text("caller_name").notNull(),
  callerPhone: text("caller_phone").notNull(),
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
});

export const insertCallSchema = createInsertSchema(callsTable).omit({
  id: true,
});
export type InsertCall = z.infer<typeof insertCallSchema>;
export type Call = typeof callsTable.$inferSelect;
