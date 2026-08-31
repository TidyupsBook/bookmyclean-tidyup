/**
 * Chat between the people who work here.
 *
 * The app is the whole notification. Posting used to also text every member
 * who wasn't reading, which turned a five-line exchange into a pile of SMS on
 * everyone's phone (and a bill to match) — now an unread message announces
 * itself in the app instead. The one text still sent by this module is the
 * receipt for a reply that arrived BY text, because swallowing that silently
 * would leave the sender thinking nobody got it.
 *
 * Membership is by seat. A conversation a cleaner is in belongs to that seat,
 * not to their login, so the same roster that decides who works here decides
 * who can read it — and no role check is a substitute for the membership
 * check, since a dispatcher must not be able to read two cleaners' thread.
 */
import { and, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import {
  db,
  staffConversationsTable,
  staffConversationMembersTable,
  staffMessagesTable,
  teamMembersTable,
  type Company,
  type StaffConversation,
} from "@workspace/db";
import type { Caller } from "./callerRole";
import { toE164 } from "./quo";
import { queueText } from "./pendingTexts";

const PREVIEW_LENGTH = 120;

function preview(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > PREVIEW_LENGTH
    ? `${oneLine.slice(0, PREVIEW_LENGTH - 1)}…`
    : oneLine;
}

/**
 * The caller's seat.
 *
 * An owner's authority comes from owning the company rather than from a seat,
 * so `caller.teamMemberId` is often null for them — but chat needs a person to
 * attribute messages to, and the owner does have a row (created with the
 * company). Fall back to it rather than inventing a second identity for them.
 *
 * A company can now hold several owner cards, because the boss signs in from
 * a phone, a tablet and the office PC. Those device cards each have a login of
 * their own, so the card the company account belongs to is the owner card with
 * no login attached — the one made with the company. Preferring it keeps the
 * founding account speaking as itself instead of borrowing whichever device
 * card happens to have the lowest id.
 */
export async function resolveChatSeat(
  company: Company,
  caller: Caller,
): Promise<{ id: number; name: string } | null> {
  if (caller.teamMemberId != null) {
    const [seat] = await db
      .select({ id: teamMembersTable.id, name: teamMembersTable.name })
      .from(teamMembersTable)
      .where(
        and(
          eq(teamMembersTable.id, caller.teamMemberId),
          eq(teamMembersTable.companyId, company.id),
        ),
      );
    if (seat) return { id: seat.id, name: caller.name || seat.name };
  }

  if (caller.role !== "owner") return null;

  const [ownerSeat] = await db
    .select({ id: teamMembersTable.id, name: teamMembersTable.name })
    .from(teamMembersTable)
    .where(
      and(
        eq(teamMembersTable.companyId, company.id),
        eq(teamMembersTable.role, "owner"),
      ),
    )
    // Login-less owner cards first (the company's own card), then by id so
    // the answer is the same on every request.
    .orderBy(
      sql`case when ${teamMembersTable.clerkUserId} is null then 0 else 1 end`,
      teamMembersTable.id,
    )
    .limit(1);
  return ownerSeat
    ? { id: ownerSeat.id, name: caller.name || ownerSeat.name }
    : null;
}

/** Sorted so the pair (7,3) and (3,7) can never open two threads. */
function directKeyFor(a: number, b: number): string {
  return [a, b].sort((x, y) => x - y).join(":");
}

export async function findOrCreateDirect(
  company: Company,
  meId: number,
  otherId: number,
): Promise<StaffConversation> {
  const key = directKeyFor(meId, otherId);

  /**
   * The conversation row and its two membership rows go in together. Written
   * separately, a request that loses the unique-key race can hand back a
   * conversation neither person is in yet — which reads as a 404 — and a
   * failure between the two writes would strand it that way for good.
   */
  const created = await db.transaction(async (tx) => {
    const [conversation] = await tx
      .insert(staffConversationsTable)
      .values({
        companyId: company.id,
        kind: "direct",
        directKey: key,
        createdByMemberId: meId,
      })
      .onConflictDoNothing({
        target: [
          staffConversationsTable.companyId,
          staffConversationsTable.directKey,
        ],
      })
      .returning();
    if (!conversation) return null;

    await tx.insert(staffConversationMembersTable).values(
      [meId, otherId].map((memberId) => ({
        companyId: company.id,
        conversationId: conversation.id,
        memberId,
      })),
    );
    return conversation;
  });
  if (created) return created;

  const [existing] = await db
    .select()
    .from(staffConversationsTable)
    .where(
      and(
        eq(staffConversationsTable.companyId, company.id),
        eq(staffConversationsTable.directKey, key),
      ),
    );
  if (!existing) throw new Error("Direct conversation vanished while creating");

  // Belt and braces for any row created before this was transactional.
  await db
    .insert(staffConversationMembersTable)
    .values(
      [meId, otherId].map((memberId) => ({
        companyId: company.id,
        conversationId: existing.id,
        memberId,
      })),
    )
    .onConflictDoNothing();
  return existing;
}

export async function createGroup(
  company: Company,
  creatorId: number,
  memberIds: number[],
  title: string,
): Promise<StaffConversation> {
  const everyone = Array.from(new Set([creatorId, ...memberIds]));

  const [conversation] = await db
    .insert(staffConversationsTable)
    .values({
      companyId: company.id,
      kind: "group",
      title,
      createdByMemberId: creatorId,
    })
    .returning();

  await db.insert(staffConversationMembersTable).values(
    everyone.map((memberId) => ({
      companyId: company.id,
      conversationId: conversation!.id,
      memberId,
    })),
  );
  return conversation!;
}

/** True when this seat is in this conversation — the only access check. */
export async function isMember(
  company: Company,
  conversationId: number,
  memberId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: staffConversationMembersTable.id })
    .from(staffConversationMembersTable)
    .where(
      and(
        eq(staffConversationMembersTable.companyId, company.id),
        eq(staffConversationMembersTable.conversationId, conversationId),
        eq(staffConversationMembersTable.memberId, memberId),
      ),
    );
  return Boolean(row);
}

/**
 * Post a message.
 *
 * Nobody is texted about it: the message becomes unread for every other member
 * and their app says so. The author's own read marker is advanced in the same
 * breath, so a sender never sees their own message counted against them.
 *
 * A message that arrived by SMS carries Quo's message id; a webhook redelivery
 * of the same text loses the unique-key race and comes back null, which the
 * caller treats as already-handled rather than an error.
 */
export async function postStaffMessage(
  company: Company,
  conversation: StaffConversation,
  author: { id: number; name: string },
  body: string,
  source?: { quoMessageId: string },
): Promise<{ id: number; createdAt: Date } | null> {
  const [message] = await db
    .insert(staffMessagesTable)
    .values({
      companyId: company.id,
      conversationId: conversation.id,
      memberId: author.id,
      authorName: author.name,
      body,
      quoMessageId: source?.quoMessageId ?? null,
    })
    .onConflictDoNothing({ target: staffMessagesTable.quoMessageId })
    .returning();
  if (!message) return null;

  await db
    .update(staffConversationsTable)
    .set({
      lastMessageAt: message!.createdAt,
      lastMessagePreview: `${author.name}: ${preview(body)}`,
    })
    .where(eq(staffConversationsTable.id, conversation.id));

  // The author has obviously read their own message.
  await db
    .update(staffConversationMembersTable)
    .set({ lastReadAt: message!.createdAt })
    .where(
      and(
        eq(staffConversationMembersTable.conversationId, conversation.id),
        eq(staffConversationMembersTable.memberId, author.id),
      ),
    );

  return { id: message!.id, createdAt: message!.createdAt };
}

/**
 * How far back a bare SMS reply can be matched to a conversation. A chat
 * notification is answered within hours; a text arriving weeks after the last
 * activity is more likely something new, and guessing a stale thread would
 * hide it from whoever should see it.
 */
export const REPLY_ROUTING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The active seat whose phone is this number.
 *
 * Team phones are stored as the owner typed them ("555-123-4567"), while the
 * webhook hands over E.164 ("+15551234567") — so equality on the raw column
 * would miss most real rosters. Both sides are normalized before comparing,
 * which a company-sized roster affords in memory.
 */
export async function findActiveMemberByPhone(
  company: Company,
  phone: string,
): Promise<{ id: number; name: string } | null> {
  const wanted = toE164(phone) ?? phone.trim();
  const rows = await db
    .select({
      id: teamMembersTable.id,
      name: teamMembersTable.name,
      phone: teamMembersTable.phone,
    })
    .from(teamMembersTable)
    .where(
      and(
        eq(teamMembersTable.companyId, company.id),
        eq(teamMembersTable.active, true),
        isNotNull(teamMembersTable.phone),
      ),
    );
  const match = rows.find(
    (r) => r.phone && (toE164(r.phone) ?? r.phone.trim()) === wanted,
  );
  return match ? { id: match.id, name: match.name } : null;
}

/**
 * Route a text somebody on the roster sent to the business line back into the
 * chat thread they were answering.
 *
 * The chat notification says "Reply in the app", but a cleaner on a doorstep
 * replies by text anyway. That reply belongs in the conversation it answers,
 * not in the customer inbox. The rule for "which conversation" is the one they
 * were most recently notified about — approximated as their most recently
 * active conversation, because notifications fire on new messages.
 *
 * Returns "routed" when the reply landed in a thread, "duplicate" when this
 * Quo message was already written (webhook redelivery), and "no_conversation"
 * when the sender is on the roster but has no recent thread — the caller must
 * then put the text somewhere visible instead of dropping it.
 *
 * On "routed", the sender is texted a receipt so they know where their words
 * went: a cleaner who texted from a doorstep can't see the app, and silence
 * reads as "the crew saw it" even when nobody did. A redelivery ("duplicate")
 * sends nothing — the first delivery already confirmed. On "no_conversation"
 * the caller sends the fallback receipt itself, after it has stored the text
 * somewhere visible (see confirmStaffReply).
 *
 * No confirmation loop is possible: the receipt goes out on the platform
 * workspace (not the company's watched line), and the webhook only processes
 * *incoming* messages, so neither the receipt itself nor its delivery events
 * can re-enter this routing path as a staff reply.
 */
export async function routeInboundStaffReply(
  company: Company,
  member: { id: number; name: string },
  input: { body: string; quoMessageId: string; fromPhone?: string },
): Promise<"routed" | "duplicate" | "no_conversation"> {
  const cutoff = new Date(Date.now() - REPLY_ROUTING_WINDOW_MS);
  const [recent] = await db
    .select({ conversation: staffConversationsTable })
    .from(staffConversationMembersTable)
    .innerJoin(
      staffConversationsTable,
      eq(
        staffConversationsTable.id,
        staffConversationMembersTable.conversationId,
      ),
    )
    .where(
      and(
        eq(staffConversationMembersTable.companyId, company.id),
        eq(staffConversationMembersTable.memberId, member.id),
        gt(staffConversationsTable.lastMessageAt, cutoff),
      ),
    )
    .orderBy(sql`${staffConversationsTable.lastMessageAt} desc`)
    .limit(1);
  // No receipt here: the caller records the message somewhere visible first,
  // and that insert's dedupe (by Quo message id) is what makes the fallback
  // receipt idempotent under webhook redelivery.
  if (!recent) return "no_conversation";

  const posted = await postStaffMessage(
    company,
    recent.conversation,
    member,
    input.body,
    { quoMessageId: input.quoMessageId },
  );
  if (posted) await confirmStaffReply(company, input.fromPhone, "routed");
  return posted ? "routed" : "duplicate";
}

/**
 * Text the sender back so they know whether their reply reached the crew.
 * Goes through the owed-text queue: the reply has already been stored, and a
 * texting outage must not turn that into an error — the receipt is retried on
 * the hourly sweep like any other owed text.
 *
 * Callers must invoke this at most once per stored message: "routed" is sent
 * from inside routeInboundStaffReply after the deduped staff-message insert,
 * and "no_conversation" is sent by the webhook only when recordInboundMessage
 * actually wrote a new row (a redelivery comes back null and sends nothing).
 */
export async function confirmStaffReply(
  company: Company,
  fromPhone: string | undefined,
  outcome: "routed" | "no_conversation",
): Promise<void> {
  if (!fromPhone) return;
  const to = toE164(fromPhone) ?? fromPhone.trim();
  await queueText(company, {
    to,
    kind: "staff_reply_receipt",
    content:
      outcome === "routed"
        ? `${company.name} — Got it. Your reply was posted to your team chat.`
        : `${company.name} — Couldn't match your text to a team chat. Please open the app and reply there so your crew sees it.`,
  });
}

/** Unread counts for every conversation this seat belongs to. */
export async function unreadCounts(
  company: Company,
  memberId: number,
): Promise<Map<number, number>> {
  const rows = await db
    .select({
      conversationId: staffConversationMembersTable.conversationId,
      unread: sql<number>`count(${staffMessagesTable.id})::int`,
    })
    .from(staffConversationMembersTable)
    .leftJoin(
      staffMessagesTable,
      and(
        eq(
          staffMessagesTable.conversationId,
          staffConversationMembersTable.conversationId,
        ),
        sql`${staffMessagesTable.memberId} <> ${memberId}`,
        sql`(${staffConversationMembersTable.lastReadAt} is null or ${staffMessagesTable.createdAt} > ${staffConversationMembersTable.lastReadAt})`,
      ),
    )
    .where(
      and(
        eq(staffConversationMembersTable.companyId, company.id),
        eq(staffConversationMembersTable.memberId, memberId),
      ),
    )
    .groupBy(staffConversationMembersTable.conversationId);

  return new Map(rows.map((r) => [r.conversationId, r.unread]));
}

/** Display names for the other people in each conversation. */
export async function memberNamesFor(
  company: Company,
  conversationIds: number[],
): Promise<Map<number, Array<{ id: number; name: string }>>> {
  if (conversationIds.length === 0) return new Map();
  const rows = await db
    .select({
      conversationId: staffConversationMembersTable.conversationId,
      id: teamMembersTable.id,
      name: teamMembersTable.name,
    })
    .from(staffConversationMembersTable)
    .innerJoin(
      teamMembersTable,
      eq(teamMembersTable.id, staffConversationMembersTable.memberId),
    )
    .where(
      and(
        eq(staffConversationMembersTable.companyId, company.id),
        inArray(staffConversationMembersTable.conversationId, conversationIds),
      ),
    );

  const byConversation = new Map<number, Array<{ id: number; name: string }>>();
  for (const row of rows) {
    const list = byConversation.get(row.conversationId) ?? [];
    list.push({ id: row.id, name: row.name });
    byConversation.set(row.conversationId, list);
  }
  return byConversation;
}

/**
 * Mark read up to a specific message — by id, not by a timestamp read back
 * from the row.
 *
 * Postgres keeps microseconds and JavaScript only keeps milliseconds, so a
 * timestamp that has been through the app is very slightly EARLIER than the
 * one stored. Writing that back leaves the last message looking newer than the
 * watermark, and it stays unread forever. Letting the database read its own
 * value avoids the whole problem.
 *
 * The watermark only ever moves forward, so two devices reading at once can't
 * wind it back.
 */
export async function markRead(
  conversationId: number,
  memberId: number,
  upTo: { messageId: number } | { at: Date },
): Promise<void> {
  const target =
    "messageId" in upTo
      ? sql`(select ${staffMessagesTable.createdAt} from ${staffMessagesTable} where ${staffMessagesTable.id} = ${upTo.messageId})`
      : sql`${upTo.at}::timestamptz`;

  await db
    .update(staffConversationMembersTable)
    .set({
      lastReadAt: sql`greatest(coalesce(${staffConversationMembersTable.lastReadAt}, ${target}), ${target})`,
    })
    .where(
      and(
        eq(staffConversationMembersTable.conversationId, conversationId),
        eq(staffConversationMembersTable.memberId, memberId),
      ),
    );
}

/** Conversations this seat is in, newest activity first. */
export async function listConversations(
  company: Company,
  memberId: number,
): Promise<StaffConversation[]> {
  const rows = await db
    .select({ conversation: staffConversationsTable })
    .from(staffConversationMembersTable)
    .innerJoin(
      staffConversationsTable,
      eq(
        staffConversationsTable.id,
        staffConversationMembersTable.conversationId,
      ),
    )
    .where(
      and(
        eq(staffConversationMembersTable.companyId, company.id),
        eq(staffConversationMembersTable.memberId, memberId),
      ),
    )
    .orderBy(sql`${staffConversationsTable.lastMessageAt} desc`)
    .limit(100);
  return rows.map((r) => r.conversation);
}

/** Messages in a conversation, oldest first. */
export async function listMessages(conversationId: number) {
  return db
    .select()
    .from(staffMessagesTable)
    .where(eq(staffMessagesTable.conversationId, conversationId))
    .orderBy(staffMessagesTable.createdAt)
    .limit(500);
}

/** Everyone this person can start a chat with: the active roster, minus them. */
export async function chatContacts(company: Company, meId: number) {
  const rows = await db
    .select({
      id: teamMembersTable.id,
      name: teamMembersTable.name,
      role: teamMembersTable.role,
      isLead: teamMembersTable.isLead,
    })
    .from(teamMembersTable)
    .where(
      and(
        eq(teamMembersTable.companyId, company.id),
        eq(teamMembersTable.active, true),
      ),
    )
    .orderBy(teamMembersTable.name);
  return rows.filter((r) => r.id !== meId);
}

/** Seats that really belong to this company — guards group creation. */
export async function validMemberIds(
  company: Company,
  ids: number[],
): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: teamMembersTable.id })
    .from(teamMembersTable)
    .where(
      and(
        eq(teamMembersTable.companyId, company.id),
        inArray(teamMembersTable.id, ids),
      ),
    );
  return rows.map((r) => r.id);
}

export { gt };
