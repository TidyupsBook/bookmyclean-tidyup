/**
 * A staff reply that arrives by SMS must land in the chat thread it was
 * answering, not the customer inbox. These tests pin the routing rule (most
 * recently active conversation), the redelivery dedupe (Quo sends webhooks
 * twice), and the fallback (no recent thread -> caller keeps it visible).
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

vi.mock("./pendingTexts", () => ({
  queueText: vi.fn(async () => {}),
}));

import { queueText } from "./pendingTexts";

function receiptTexts(): Array<{ to: string | null; content: string }> {
  return vi
    .mocked(queueText)
    .mock.calls.filter(([, input]) => input.kind === "staff_reply_receipt")
    .map(([, input]) => ({ to: input.to, content: input.content }));
}

import {
  db,
  companiesTable,
  teamMembersTable,
  staffConversationsTable,
  staffConversationMembersTable,
  staffMessagesTable,
  type Company,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  routeInboundStaffReply,
  findActiveMemberByPhone,
  confirmStaffReply,
  REPLY_ROUTING_WINDOW_MS,
} from "./staffChat";
import { recordInboundMessage } from "./clientMessaging";
import { clientMessagesTable, clientThreadsTable } from "@workspace/db";

const runId = `${Date.now()}_${process.pid}`;

let company: Company;
let cleaner: { id: number; name: string };
let other: { id: number; name: string };
const conversationIds: number[] = [];

async function makeConversation(
  members: number[],
  lastMessageAt: Date,
): Promise<number> {
  const [conversation] = await db
    .insert(staffConversationsTable)
    .values({
      companyId: company.id,
      kind: "group",
      title: `route-test-${runId}-${conversationIds.length}`,
      lastMessageAt,
    })
    .returning();
  await db.insert(staffConversationMembersTable).values(
    members.map((memberId) => ({
      companyId: company.id,
      conversationId: conversation!.id,
      memberId,
    })),
  );
  conversationIds.push(conversation!.id);
  return conversation!.id;
}

beforeAll(async () => {
  const [c] = await db
    .insert(companiesTable)
    .values({
      name: `Route Reply Test ${runId}`,
      ownerUserId: `route_reply_owner_${runId}`,
    })
    .returning();
  company = c!;

  const [cleanerRow] = await db
    .insert(teamMembersTable)
    .values({
      companyId: company.id,
      name: "Reply Cleaner",
      role: "cleaner",
      // Stored as the owner typed it, NOT E.164 — real rosters look like this
      // and the webhook lookup must still match the +1... sender.
      phone: `555-${String(Date.now()).slice(-7, -4)}-${String(Date.now()).slice(-4)}`,
    })
    .returning();
  cleaner = { id: cleanerRow!.id, name: cleanerRow!.name };

  const [otherRow] = await db
    .insert(teamMembersTable)
    .values({
      companyId: company.id,
      name: "Other Member",
      role: "dispatcher",
    })
    .returning();
  other = { id: otherRow!.id, name: otherRow!.name };
});

afterAll(async () => {
  if (conversationIds.length > 0) {
    await db
      .delete(staffMessagesTable)
      .where(inArray(staffMessagesTable.conversationId, conversationIds));
    await db
      .delete(staffConversationMembersTable)
      .where(
        inArray(staffConversationMembersTable.conversationId, conversationIds),
      );
    await db
      .delete(staffConversationsTable)
      .where(inArray(staffConversationsTable.id, conversationIds));
  }
  await db
    .delete(clientMessagesTable)
    .where(eq(clientMessagesTable.companyId, company.id));
  await db
    .delete(clientThreadsTable)
    .where(eq(clientThreadsTable.companyId, company.id));
  await db
    .delete(teamMembersTable)
    .where(eq(teamMembersTable.companyId, company.id));
  await db.delete(companiesTable).where(eq(companiesTable.id, company.id));
});

describe("findActiveMemberByPhone", () => {
  it("matches an E.164 sender against a roster phone stored as typed", async () => {
    const digits = String(Date.now()).slice(-7);
    const sender = `+1555${digits}`;
    const [row] = await db
      .select({ phone: teamMembersTable.phone })
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, cleaner.id));
    // Sanity: the stored value really is formatted, not E.164.
    expect(row!.phone).not.toMatch(/^\+/);

    const found = await findActiveMemberByPhone(
      company,
      `+1555${row!.phone!.replace(/\D/g, "").slice(-7)}`,
    );
    expect(found?.id).toBe(cleaner.id);

    expect(await findActiveMemberByPhone(company, sender + "9")).toBeNull();
  });

  it("ignores inactive members", async () => {
    await db
      .update(teamMembersTable)
      .set({ active: false })
      .where(eq(teamMembersTable.id, cleaner.id));
    const [row] = await db
      .select({ phone: teamMembersTable.phone })
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, cleaner.id));
    expect(await findActiveMemberByPhone(company, row!.phone!)).toBeNull();
    await db
      .update(teamMembersTable)
      .set({ active: true })
      .where(eq(teamMembersTable.id, cleaner.id));
  });
});

describe("routeInboundStaffReply", () => {
  it("reports no_conversation when the sender has no recent thread, sending no receipt itself", async () => {
    vi.mocked(queueText).mockClear();
    const result = await routeInboundStaffReply(company, cleaner, {
      body: "hello?",
      quoMessageId: `quo_route_none_${runId}`,
      fromPhone: "+15550001111",
    });
    expect(result).toBe("no_conversation");
    // The fallback receipt is the webhook's job, sent only after the text is
    // recorded somewhere visible — routing alone must not text anyone.
    expect(receiptTexts()).toHaveLength(0);
  });

  it("sends exactly one fallback receipt under webhook redelivery (gated on the deduped record)", async () => {
    // Mirrors the webhook's fallback: record the inbound text, and only text
    // the sender back when the record was newly written.
    vi.mocked(queueText).mockClear();
    const quoMessageId = `quo_route_fallback_${runId}`;
    const from = "+15550002222";

    for (let delivery = 0; delivery < 2; delivery++) {
      const routed = await routeInboundStaffReply(company, cleaner, {
        body: "anyone there?",
        quoMessageId,
        fromPhone: from,
      });
      expect(routed).toBe("no_conversation");
      const recorded = await recordInboundMessage(company, {
        fromPhone: from,
        body: "anyone there?",
        quoMessageId,
      });
      if (recorded) await confirmStaffReply(company, from, "no_conversation");
    }

    const receipts = receiptTexts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.to).toBe(from);
    expect(receipts[0]!.content).toMatch(/open the app/i);
  });

  it("ignores threads whose last activity is outside the routing window", async () => {
    await makeConversation(
      [cleaner.id, other.id],
      new Date(Date.now() - REPLY_ROUTING_WINDOW_MS - 60_000),
    );
    const result = await routeInboundStaffReply(company, cleaner, {
      body: "too late",
      quoMessageId: `quo_route_stale_${runId}`,
    });
    expect(result).toBe("no_conversation");
  });

  it("routes into the most recently active conversation and dedupes redelivery", async () => {
    await makeConversation(
      [cleaner.id, other.id],
      new Date(Date.now() - 60 * 60 * 1000),
    );
    const newest = await makeConversation(
      [cleaner.id, other.id],
      new Date(Date.now() - 5 * 60 * 1000),
    );

    const quoMessageId = `quo_route_hit_${runId}`;
    vi.mocked(queueText).mockClear();
    const first = await routeInboundStaffReply(company, cleaner, {
      body: "on my way",
      quoMessageId,
      fromPhone: "+15550001111",
    });
    expect(first).toBe("routed");

    // The sender is told their reply landed in the team chat.
    const receipts = receiptTexts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.to).toBe("+15550001111");
    expect(receipts[0]!.content).toMatch(/team chat/i);

    const messages = await db
      .select()
      .from(staffMessagesTable)
      .where(eq(staffMessagesTable.quoMessageId, quoMessageId));
    expect(messages).toHaveLength(1);
    expect(messages[0]!.conversationId).toBe(newest);
    expect(messages[0]!.memberId).toBe(cleaner.id);
    expect(messages[0]!.authorName).toBe(cleaner.name);
    expect(messages[0]!.body).toBe("on my way");

    // Quo redelivers webhooks; the same message id must not post twice,
    // and the sender must not be texted a second receipt for it.
    vi.mocked(queueText).mockClear();
    const again = await routeInboundStaffReply(company, cleaner, {
      body: "on my way",
      quoMessageId,
      fromPhone: "+15550001111",
    });
    expect(again).toBe("duplicate");
    expect(receiptTexts()).toHaveLength(0);
    const after = await db
      .select()
      .from(staffMessagesTable)
      .where(eq(staffMessagesTable.quoMessageId, quoMessageId));
    expect(after).toHaveLength(1);
  });
});
