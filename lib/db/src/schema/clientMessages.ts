import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

/**
 * One running text conversation with one customer.
 *
 * Keyed by the customer's number rather than by a booking, because that is how
 * texting actually behaves: the same person texts about last month's clean and
 * next week's quote in the same thread, and a number that has never booked
 * anything can still text the business line. The booking, if there is one, is
 * looked up from the number — not the other way round.
 *
 * The last-message and unread columns are denormalised on purpose so the inbox
 * list is one query no matter how long the threads get.
 */
export const clientThreadsTable = pgTable(
  "client_threads",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    /** E.164. The thread key — one per customer number per company. */
    customerPhone: text("customer_phone").notNull(),
    /**
     * Best name we know for this number, copied from a booking or call at the
     * time the thread was touched. Null when a stranger texts in.
     */
    customerName: text("customer_name"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** First line of the newest message, for the inbox list. */
    lastMessagePreview: text("last_message_preview"),
    lastDirection: text("last_direction"),
    /** Inbound messages nobody has opened yet. */
    unreadCount: integer("unread_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("client_threads_company_phone_key").on(t.companyId, t.customerPhone),
    index("client_threads_company_activity_idx").on(
      t.companyId,
      t.lastMessageAt,
    ),
  ],
);

/**
 * A single text, in or out.
 *
 * `quoMessageId` is unique so a webhook Quo delivers twice — which it does —
 * cannot write the customer's message into the thread twice.
 */
export const clientMessagesTable = pgTable(
  "client_messages",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    threadId: integer("thread_id")
      .notNull()
      .references(() => clientThreadsTable.id),
    /** inbound = from the customer, outbound = from the company. */
    direction: text("direction").notNull(),
    body: text("body").notNull(),
    /** Quo's id for this message, when it came from or went through Quo. */
    quoMessageId: text("quo_message_id").unique(),
    /** Who on the team sent it. Null for inbound and for automatic texts. */
    sentByName: text("sent_by_name"),
    /** received | sent | failed */
    status: text("status").notNull().default("sent"),
    /** Why a send failed, in words the dispatcher can act on. */
    errorText: text("error_text"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("client_messages_thread_idx").on(t.threadId, t.createdAt)],
);

export type ClientThread = typeof clientThreadsTable.$inferSelect;
export type ClientMessage = typeof clientMessagesTable.$inferSelect;
