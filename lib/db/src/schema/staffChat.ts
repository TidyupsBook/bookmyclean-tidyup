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
import { teamMembersTable } from "./teamMembers";

/**
 * Chat between the people who work here.
 *
 * Conversations belong to the company, not to the person who started them: a
 * crew talks about today's jobs, and that thread has to survive whoever leaves.
 * Membership is by seat (team member), never by Clerk account, so the same
 * rules that decide who is on the roster decide who can read a thread.
 *
 * `directKey` is what stops two people opening two separate one-to-one threads
 * with each other: for a direct conversation it is the two seat ids sorted and
 * joined, unique per company. Groups leave it null and can be created freely.
 */
export const staffConversationsTable = pgTable(
  "staff_conversations",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    /** "direct" (exactly two people) or "group". */
    kind: text("kind").notNull().default("direct"),
    /** Group name. Null for a direct thread, which is titled by the other person. */
    title: text("title"),
    directKey: text("direct_key"),
    createdByMemberId: integer("created_by_member_id").references(
      () => teamMembersTable.id,
    ),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastMessagePreview: text("last_message_preview"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("staff_conversations_direct_key").on(t.companyId, t.directKey),
    index("staff_conversations_company_activity_idx").on(
      t.companyId,
      t.lastMessageAt,
    ),
  ],
);

/**
 * Who is in a conversation, and how far they have read.
 *
 * `lastReadAt` is a watermark rather than a counter so it can never drift: the
 * unread count is always "messages newer than this", which stays correct even
 * if a delivery is written twice or read on two devices at once.
 */
export const staffConversationMembersTable = pgTable(
  "staff_conversation_members",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => staffConversationsTable.id),
    memberId: integer("member_id")
      .notNull()
      .references(() => teamMembersTable.id),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("staff_conversation_members_unique").on(
      t.conversationId,
      t.memberId,
    ),
    index("staff_conversation_members_member_idx").on(t.companyId, t.memberId),
  ],
);

export const staffMessagesTable = pgTable(
  "staff_messages",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => staffConversationsTable.id),
    /** The seat that wrote it. Kept even if the person later leaves. */
    memberId: integer("member_id")
      .notNull()
      .references(() => teamMembersTable.id),
    /** Copied at write time so an old message still shows who said it. */
    authorName: text("author_name").notNull(),
    body: text("body").notNull(),
    /**
     * Set when the message arrived as an SMS reply to a chat notification.
     * Unique so Quo's webhook redeliveries can't write the reply twice.
     */
    quoMessageId: text("quo_message_id").unique(
      "staff_messages_quo_message_id_unique",
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("staff_messages_conversation_idx").on(t.conversationId, t.createdAt),
  ],
);

export type StaffConversation = typeof staffConversationsTable.$inferSelect;
export type StaffConversationMember =
  typeof staffConversationMembersTable.$inferSelect;
export type StaffMessage = typeof staffMessagesTable.$inferSelect;
