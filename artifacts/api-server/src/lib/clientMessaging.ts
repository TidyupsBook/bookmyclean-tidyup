/**
 * Two-way texting with customers.
 *
 * The business line is the company's, not any one person's: a text a customer
 * sends at 6am has to be readable by whoever opens the dashboard, and a reply
 * has to leave from the same number the customer already knows. So both
 * directions are written into one thread keyed by the customer's number, and
 * nothing here reads or writes a personal handset.
 *
 * Inbound arrives by Quo webhook, which redelivers. Every stored message keeps
 * Quo's own message id under a unique constraint, so a repeat delivery loses
 * the race instead of duplicating the customer's words.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  clientThreadsTable,
  clientMessagesTable,
  bookingsTable,
  callsTable,
  teamMembersTable,
  type Company,
  type ClientThread,
} from "@workspace/db";
import { listPhoneNumbers, sendMessage, toE164 } from "./quo";
import { companyQuoKey } from "./company";
import { logger } from "./logger";

const PREVIEW_LENGTH = 140;

function preview(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > PREVIEW_LENGTH
    ? `${oneLine.slice(0, PREVIEW_LENGTH - 1)}…`
    : oneLine;
}

/**
 * The best name we know for a number: a booking's customer beats a call's
 * caller id, and the most recent of either wins. Null for a stranger, which
 * the inbox shows as the number itself rather than inventing "Unknown".
 */
export async function nameForPhone(
  company: Company,
  phone: string,
): Promise<string | null> {
  const [booking] = await db
    .select({ name: bookingsTable.customerName })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.companyId, company.id),
        eq(bookingsTable.customerPhone, phone),
      ),
    )
    .orderBy(desc(bookingsTable.createdAt))
    .limit(1);
  if (booking?.name) return booking.name;

  const [call] = await db
    .select({ name: callsTable.callerName })
    .from(callsTable)
    .where(
      and(
        eq(callsTable.companyId, company.id),
        eq(callsTable.callerPhone, phone),
      ),
    )
    .orderBy(desc(callsTable.startedAt))
    .limit(1);
  if (call?.name) return call.name;

  // Staff get texted from the same business line, so a crew member replying to
  // a chat notification lands here. Label it rather than showing a bare number
  // that looks like an unknown customer nobody can place. Roster phones are
  // stored as typed ("555-123-4567") while inbound is E.164, so both sides
  // are normalized before comparing.
  const members = await db
    .select({ name: teamMembersTable.name, phone: teamMembersTable.phone })
    .from(teamMembersTable)
    .where(eq(teamMembersTable.companyId, company.id));
  const wanted = toE164(phone) ?? phone.trim();
  const member = members.find(
    (m) => m.phone && (toE164(m.phone) ?? m.phone.trim()) === wanted,
  );
  return member?.name ? `${member.name} (your team)` : null;
}

/**
 * Find this customer's thread or start one. Concurrent inbound texts from the
 * same number race here, so the insert defers to the unique key rather than
 * checking first and hoping.
 */
export async function findOrCreateThread(
  company: Company,
  phone: string,
  name?: string | null,
): Promise<ClientThread> {
  const resolvedName = name ?? (await nameForPhone(company, phone));

  const [created] = await db
    .insert(clientThreadsTable)
    .values({
      companyId: company.id,
      customerPhone: phone,
      customerName: resolvedName,
    })
    .onConflictDoNothing({
      target: [clientThreadsTable.companyId, clientThreadsTable.customerPhone],
    })
    .returning();
  if (created) return created;

  const [existing] = await db
    .select()
    .from(clientThreadsTable)
    .where(
      and(
        eq(clientThreadsTable.companyId, company.id),
        eq(clientThreadsTable.customerPhone, phone),
      ),
    );
  if (!existing) throw new Error("Thread vanished while being created");

  // Fill in a name we didn't have when the thread started — a stranger who
  // texts first and books later should stop showing as a bare number.
  if (!existing.customerName && resolvedName) {
    const [named] = await db
      .update(clientThreadsTable)
      .set({ customerName: resolvedName })
      .where(eq(clientThreadsTable.id, existing.id))
      .returning();
    return named ?? existing;
  }
  return existing;
}

/**
 * Record a text the customer sent us.
 *
 * Returns null when this exact Quo message is already in the thread, which is
 * the normal outcome of a redelivered webhook and not an error.
 */
export async function recordInboundMessage(
  company: Company,
  input: {
    fromPhone: string;
    body: string;
    quoMessageId: string;
    receivedAt?: Date;
  },
): Promise<{ threadId: number; messageId: number } | null> {
  const phone = toE164(input.fromPhone) ?? input.fromPhone.trim();
  const thread = await findOrCreateThread(company, phone);

  const [message] = await db
    .insert(clientMessagesTable)
    .values({
      companyId: company.id,
      threadId: thread.id,
      direction: "inbound",
      body: input.body,
      quoMessageId: input.quoMessageId,
      status: "received",
      ...(input.receivedAt ? { createdAt: input.receivedAt } : {}),
    })
    .onConflictDoNothing({ target: clientMessagesTable.quoMessageId })
    .returning();
  if (!message) return null;

  await db
    .update(clientThreadsTable)
    .set({
      lastMessageAt: message.createdAt,
      lastMessagePreview: preview(input.body),
      lastDirection: "inbound",
      unreadCount: sql`${clientThreadsTable.unreadCount} + 1`,
    })
    .where(eq(clientThreadsTable.id, thread.id));

  return { threadId: thread.id, messageId: message.id };
}

/**
 * Which of the company's own lines a reply goes out from. Their receptionist
 * number, so the customer sees the thread they already know.
 */
async function resolveSendingNumber(
  company: Company,
  apiKey: string,
): Promise<{ from: string } | { blockedReason: string }> {
  if (company.quoNumberIds.length === 0) {
    return {
      blockedReason:
        "Choose which Quo number your receptionist uses before texting customers.",
    };
  }
  let numbers;
  try {
    numbers = await listPhoneNumbers(apiKey);
  } catch (err) {
    logger.warn({ err }, "Could not list Quo numbers for a customer text");
    return {
      blockedReason:
        "Couldn't reach Quo to find your number. Try again shortly.",
    };
  }
  const match =
    numbers.find((n) => n.id === company.quoNumberIds[0]) ??
    numbers.find((n) => company.quoNumberIds.includes(n.id));
  if (!match) {
    return {
      blockedReason:
        "That Quo number is no longer in your workspace. Reconnect Quo to fix it.",
    };
  }
  return { from: match.number };
}

export type SendResult =
  | { ok: true; threadId: number; messageId: number }
  | { ok: false; reason: string; status: number; threadId?: number };

/**
 * Send a reply and file it in the thread.
 *
 * A failed send is written down as a failed message rather than thrown away:
 * the dispatcher needs to see that the customer never got it, and needs the
 * words back to try again.
 */
export async function sendClientText(
  company: Company,
  input: { toPhone: string; body: string; sentByName?: string | null },
): Promise<SendResult> {
  const body = input.body.trim();
  if (!body) return { ok: false, reason: "Write a message first", status: 400 };

  const phone = toE164(input.toPhone);
  if (!phone) {
    return {
      ok: false,
      reason: "That doesn't look like a phone number we can text",
      status: 400,
    };
  }

  const thread = await findOrCreateThread(company, phone);

  /**
   * Whatever stops a text going out, the words survive it. The dispatcher
   * typed something they meant to say; a 409 that only lives in a toast is
   * gone the moment they switch pages.
   */
  const recordFailure = async (reason: string, status: number) => {
    const [row] = await db
      .insert(clientMessagesTable)
      .values({
        companyId: company.id,
        threadId: thread.id,
        direction: "outbound",
        body,
        sentByName: input.sentByName ?? null,
        status: "failed",
        errorText: reason,
      })
      .returning();
    await db
      .update(clientThreadsTable)
      .set({
        lastMessageAt: row!.createdAt,
        lastMessagePreview: preview(body),
        lastDirection: "outbound",
      })
      .where(eq(clientThreadsTable.id, thread.id));
    return { ok: false as const, reason, status, threadId: thread.id };
  };

  const apiKey = companyQuoKey(company);
  if (!apiKey) {
    return recordFailure("Connect your Quo account to text customers.", 409);
  }
  const sender = await resolveSendingNumber(company, apiKey);
  if ("blockedReason" in sender) {
    return recordFailure(sender.blockedReason, 409);
  }

  let quoMessageId: string | null = null;
  let failure: string | null = null;
  try {
    const sent = await sendMessage(apiKey, {
      from: sender.from,
      to: phone,
      content: body,
    });
    quoMessageId = sent.id ?? null;
  } catch (err) {
    failure = err instanceof Error ? err.message : "Quo rejected the message";
    logger.error({ err, companyId: company.id }, "Customer text failed");
  }

  const [message] = await db
    .insert(clientMessagesTable)
    .values({
      companyId: company.id,
      threadId: thread.id,
      direction: "outbound",
      body,
      quoMessageId,
      sentByName: input.sentByName ?? null,
      status: failure ? "failed" : "sent",
      errorText: failure,
    })
    .returning();

  // A failed attempt still belongs at the top of the inbox — it is the thing
  // most in need of attention.
  await db
    .update(clientThreadsTable)
    .set({
      lastMessageAt: message!.createdAt,
      lastMessagePreview: preview(body),
      lastDirection: "outbound",
    })
    .where(eq(clientThreadsTable.id, thread.id));

  if (failure) {
    return {
      ok: false,
      reason: `Couldn't send it: ${failure}`,
      status: 502,
      threadId: thread.id,
    };
  }
  return { ok: true, threadId: thread.id, messageId: message!.id };
}
