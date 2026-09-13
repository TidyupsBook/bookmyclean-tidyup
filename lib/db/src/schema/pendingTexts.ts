import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { z } from "zod/v4";

export const pendingTextSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("team_member"), id: z.number().int().positive() }),
  z.object({ type: z.literal("lead"), id: z.number().int().positive() }),
  z.object({ type: z.literal("client"), id: z.number().int().positive() }),
]);
export type PendingTextSource = z.infer<typeof pendingTextSourceSchema>;

/**
 * A text message the app still owes somebody.
 *
 * The same discipline as the Quo outage marker (companies.quoNotifyPending),
 * generalised: the row IS the retry state, kept apart from whatever state
 * change earned the text. A sender claims the row by deleting it, attempts
 * delivery, and puts it back on failure — so a send hiccup can never lose the
 * message, and two concurrent retriers can never double-text anyone.
 *
 * Rows are written already composed (final content, final recipient) so a
 * retry needs nothing from the moment that created them — the team member row
 * it was about may be long gone, as it is for a declined join request.
 */
export const pendingTextsTable = pgTable("pending_texts", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companiesTable.id),
  /**
   * E.164 recipient, or null meaning "the company's owner" — resolved at send
   * time from the company's ring-through / notification number, so a text
   * queued before the owner fixed their number still goes out afterwards.
   */
  toPhone: text("to_phone"),
  /** What this text is about, for logs — e.g. "join_request_owner". */
  kind: text("kind").notNull(),
  content: text("content").notNull(),
  /**
   * The company-owned record whose phone supplied `toPhone`, when one still
   * exists. This is only a reference: delivery never depends on the source.
   */
  source: jsonb("source").$type<PendingTextSource | null>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PendingText = typeof pendingTextsTable.$inferSelect;
