/**
 * Staff chat routes.
 *
 * Open to every role, including cleaners — a crew has to be able to talk to
 * each other without going through the office. Access to any one conversation
 * is decided by membership, never by role: being a dispatcher does not let you
 * read two cleaners' thread.
 */
import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, staffConversationsTable } from "@workspace/db";
import {
  ListStaffConversationsResponse,
  GetStaffConversationParams,
  GetStaffConversationResponse,
  StartStaffConversationBody,
  StartStaffConversationResponse,
  SendStaffMessageParams,
  SendStaffMessageBody,
  SendStaffMessageResponse,
  ListChatContactsResponse,
} from "@workspace/api-zod";
import { requireRole, getCaller } from "../middlewares/requireRole";
import {
  chatContacts,
  createGroup,
  findOrCreateDirect,
  isMember,
  listConversations,
  listMessages,
  markRead,
  memberNamesFor,
  postStaffMessage,
  resolveChatSeat,
  unreadCounts,
  validMemberIds,
} from "../lib/staffChat";
import { liveMemberIds } from "../lib/presence";

const router: IRouter = Router();

const ALL_ROLES = ["owner", "dispatcher", "cleaner"] as const;

/** A group is titled; a direct thread is named after the other person. */
function conversationTitle(
  conversation: { kind: string; title: string | null },
  others: Array<{ name: string }>,
): string {
  if (conversation.kind === "group") {
    return (
      conversation.title || others.map((o) => o.name).join(", ") || "Group chat"
    );
  }
  return others[0]?.name ?? "Chat";
}

router.get(
  "/staff-chat/conversations",
  requireRole(...ALL_ROLES),
  async (req, res): Promise<void> => {
    const caller = await getCaller(req);
    if (!caller.company) {
      res.json(ListStaffConversationsResponse.parse([]));
      return;
    }
    const seat = await resolveChatSeat(caller.company, caller);
    if (!seat) {
      res.json(ListStaffConversationsResponse.parse([]));
      return;
    }

    const conversations = await listConversations(caller.company, seat.id);
    const [unread, names, live] = await Promise.all([
      unreadCounts(caller.company, seat.id),
      memberNamesFor(
        caller.company,
        conversations.map((c) => c.id),
      ),
      liveMemberIds(caller.company.id),
    ]);

    res.json(
      ListStaffConversationsResponse.parse(
        conversations.map((c) => {
          const others = (names.get(c.id) ?? []).filter(
            (m) => m.id !== seat.id,
          );
          return {
            id: c.id,
            kind: c.kind as "direct" | "group",
            title: conversationTitle(c, others),
            memberNames: others.map((o) => o.name),
            members: others.map((o) => ({
              id: o.id,
              name: o.name,
              isLive: live.has(o.id),
            })),
            lastMessageAt: c.lastMessageAt.toISOString(),
            lastMessagePreview: c.lastMessagePreview,
            unreadCount: unread.get(c.id) ?? 0,
          };
        }),
      ),
    );
  },
);

/** Who this person can start a chat with. */
router.get(
  "/staff-chat/contacts",
  requireRole(...ALL_ROLES),
  async (req, res): Promise<void> => {
    const caller = await getCaller(req);
    if (!caller.company) {
      res.json(ListChatContactsResponse.parse([]));
      return;
    }
    const seat = await resolveChatSeat(caller.company, caller);
    const [contacts, live] = await Promise.all([
      chatContacts(caller.company, seat?.id ?? -1),
      liveMemberIds(caller.company.id),
    ]);
    res.json(
      ListChatContactsResponse.parse(
        contacts.map((c) => ({
          id: c.id,
          name: c.name,
          role: c.role,
          isLead: c.isLead,
          isLive: live.has(c.id),
        })),
      ),
    );
  },
);

/**
 * Start (or reopen) a conversation. One other person means a direct thread,
 * which is deduplicated; two or more means a group, which is not — a crew can
 * legitimately want two groups with the same people in them.
 */
router.post(
  "/staff-chat/conversations",
  requireRole(...ALL_ROLES),
  async (req, res): Promise<void> => {
    const parsed = StartStaffConversationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const caller = await getCaller(req);
    if (!caller.company) {
      res.status(409).json({ error: "Finish setting up your company first" });
      return;
    }
    const seat = await resolveChatSeat(caller.company, caller);
    if (!seat) {
      res
        .status(409)
        .json({ error: "You need a staff card before you can chat" });
      return;
    }

    // Anything not on this company's roster is dropped rather than trusted.
    const wanted = await validMemberIds(
      caller.company,
      parsed.data.memberIds.filter((id) => id !== seat.id),
    );
    if (wanted.length === 0) {
      res.status(400).json({ error: "Pick who you want to message" });
      return;
    }

    const conversation =
      wanted.length === 1
        ? await findOrCreateDirect(caller.company, seat.id, wanted[0]!)
        : await createGroup(
            caller.company,
            seat.id,
            wanted,
            parsed.data.title?.trim() || "Crew chat",
          );

    const [names, live] = await Promise.all([
      memberNamesFor(caller.company, [conversation.id]),
      liveMemberIds(caller.company.id),
    ]);
    const others = (names.get(conversation.id) ?? []).filter(
      (m) => m.id !== seat.id,
    );

    res.json(
      StartStaffConversationResponse.parse({
        id: conversation.id,
        kind: conversation.kind as "direct" | "group",
        title: conversationTitle(conversation, others),
        memberNames: others.map((o) => o.name),
        members: others.map((o) => ({
          id: o.id,
          name: o.name,
          isLive: live.has(o.id),
        })),
        lastMessageAt: conversation.lastMessageAt.toISOString(),
        lastMessagePreview: conversation.lastMessagePreview,
        unreadCount: 0,
      }),
    );
  },
);

router.get(
  "/staff-chat/conversations/:id",
  requireRole(...ALL_ROLES),
  async (req, res): Promise<void> => {
    const params = GetStaffConversationParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const caller = await getCaller(req);
    const seat = caller.company
      ? await resolveChatSeat(caller.company, caller)
      : null;
    if (!caller.company || !seat) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const [conversation] = await db
      .select()
      .from(staffConversationsTable)
      .where(
        and(
          eq(staffConversationsTable.id, params.data.id),
          eq(staffConversationsTable.companyId, caller.company.id),
        ),
      );
    // Not a member reads exactly like not existing — no hint that it's there.
    if (
      !conversation ||
      !(await isMember(caller.company, conversation.id, seat.id))
    ) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    // Pinned before the read so a message that lands mid-request stays unread
    // even when the thread is empty and there is no message time to use.
    const readAt = new Date();
    const messages = await listMessages(conversation.id);
    const [names, live] = await Promise.all([
      memberNamesFor(caller.company, [conversation.id]),
      liveMemberIds(caller.company.id),
    ]);
    const others = (names.get(conversation.id) ?? []).filter(
      (m) => m.id !== seat.id,
    );
    // Read up to the newest message we are actually handing over. Stamping
    // "now" would swallow anything posted while this request was running.
    const newest = messages[messages.length - 1];
    await markRead(
      conversation.id,
      seat.id,
      newest ? { messageId: newest.id } : { at: readAt },
    );

    res.json(
      GetStaffConversationResponse.parse({
        conversation: {
          id: conversation.id,
          kind: conversation.kind as "direct" | "group",
          title: conversationTitle(conversation, others),
          memberNames: others.map((o) => o.name),
          members: others.map((o) => ({
            id: o.id,
            name: o.name,
            isLive: live.has(o.id),
          })),
          lastMessageAt: conversation.lastMessageAt.toISOString(),
          lastMessagePreview: conversation.lastMessagePreview,
          unreadCount: 0,
        },
        myMemberId: seat.id,
        messages: messages.map((m) => ({
          id: m.id,
          memberId: m.memberId,
          authorName: m.authorName,
          body: m.body,
          createdAt: m.createdAt.toISOString(),
        })),
      }),
    );
  },
);

router.post(
  "/staff-chat/conversations/:id/messages",
  requireRole(...ALL_ROLES),
  async (req, res): Promise<void> => {
    const params = SendStaffMessageParams.safeParse(req.params);
    const parsed = SendStaffMessageBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({
        error: (params.success ? parsed.error : params.error)!.message,
      });
      return;
    }
    const body = parsed.data.body.trim();
    if (!body) {
      res.status(400).json({ error: "Write a message first" });
      return;
    }

    const caller = await getCaller(req);
    const seat = caller.company
      ? await resolveChatSeat(caller.company, caller)
      : null;
    if (!caller.company || !seat) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const [conversation] = await db
      .select()
      .from(staffConversationsTable)
      .where(
        and(
          eq(staffConversationsTable.id, params.data.id),
          eq(staffConversationsTable.companyId, caller.company.id),
        ),
      );
    if (
      !conversation ||
      !(await isMember(caller.company, conversation.id, seat.id))
    ) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const message = await postStaffMessage(
      caller.company,
      conversation,
      seat,
      body,
    );
    // Only an SMS-sourced message can lose the dedupe race; an in-app post
    // has no Quo id, so this cannot happen here.
    if (!message) {
      res.status(500).json({ error: "Message could not be written" });
      return;
    }

    res.json(
      SendStaffMessageResponse.parse({
        id: message.id,
        memberId: seat.id,
        authorName: seat.name,
        body,
        createdAt: message.createdAt.toISOString(),
      }),
    );
  },
);

export default router;
