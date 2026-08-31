/**
 * The customer inbox: threads on the business line, and replies back out.
 *
 * Dispatch-only. Texts with customers carry prices, addresses and whatever
 * else a homeowner chooses to type, so the crew role is not on this router at
 * all — a cleaner who needs to reach a customer uses the number on the job.
 */
import { Router, type IRouter } from "express";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, clientThreadsTable, clientMessagesTable } from "@workspace/db";
import {
  ListMessageThreadsResponse,
  GetMessageThreadParams,
  GetMessageThreadResponse,
  StartMessageThreadBody,
  StartMessageThreadResponse,
  SendClientMessageParams,
  SendClientMessageBody,
  SendClientMessageResponse,
} from "@workspace/api-zod";
import { requireRole, getCaller } from "../middlewares/requireRole";
import {
  findOrCreateThread,
  sendClientText,
  nameForPhone,
} from "../lib/clientMessaging";
import { toE164 } from "../lib/quo";

const router: IRouter = Router();

function serializeThread(row: typeof clientThreadsTable.$inferSelect) {
  return {
    id: row.id,
    customerPhone: row.customerPhone,
    customerName: row.customerName,
    lastMessageAt: row.lastMessageAt.toISOString(),
    lastMessagePreview: row.lastMessagePreview,
    lastDirection: row.lastDirection,
    unreadCount: row.unreadCount,
  };
}

function serializeMessage(row: typeof clientMessagesTable.$inferSelect) {
  return {
    id: row.id,
    direction: row.direction as "inbound" | "outbound",
    body: row.body,
    status: row.status as "received" | "sent" | "failed",
    errorText: row.errorText,
    sentByName: row.sentByName,
    createdAt: row.createdAt.toISOString(),
  };
}

router.get(
  "/messages/threads",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const caller = await getCaller(req);
    if (!caller.company) {
      res.json(ListMessageThreadsResponse.parse([]));
      return;
    }
    const rows = await db
      .select()
      .from(clientThreadsTable)
      .where(eq(clientThreadsTable.companyId, caller.company.id))
      .orderBy(desc(clientThreadsTable.lastMessageAt))
      .limit(200);
    res.json(ListMessageThreadsResponse.parse(rows.map(serializeThread)));
  },
);

/**
 * Open one thread. Reading it is what clears the unread badge — there is no
 * separate "mark as read" for a dispatcher to forget to press.
 */
router.get(
  "/messages/threads/:id",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = GetMessageThreadParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const caller = await getCaller(req);
    if (!caller.company) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const [thread] = await db
      .select()
      .from(clientThreadsTable)
      .where(
        and(
          eq(clientThreadsTable.id, params.data.id),
          eq(clientThreadsTable.companyId, caller.company.id),
        ),
      );
    if (!thread) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const messages = await db
      .select()
      .from(clientMessagesTable)
      .where(
        and(
          eq(clientMessagesTable.threadId, thread.id),
          eq(clientMessagesTable.companyId, caller.company.id),
        ),
      )
      .orderBy(asc(clientMessagesTable.createdAt))
      .limit(500);

    // Clear only what was unread when we started reading. A text that lands
    // mid-request would otherwise be marked read without anyone seeing it.
    if (thread.unreadCount > 0) {
      await db
        .update(clientThreadsTable)
        .set({
          unreadCount: sql`greatest(${clientThreadsTable.unreadCount} - ${thread.unreadCount}, 0)`,
        })
        .where(eq(clientThreadsTable.id, thread.id));
    }

    res.json(
      GetMessageThreadResponse.parse({
        thread: serializeThread({ ...thread, unreadCount: 0 }),
        messages: messages.map(serializeMessage),
      }),
    );
  },
);

/**
 * Open (or reopen) the thread for a number — how the Text buttons scattered
 * around the app land somewhere useful before a word has been typed.
 */
router.post(
  "/messages/threads",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const parsed = StartMessageThreadBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const caller = await getCaller(req);
    if (!caller.company) {
      res.status(409).json({ error: "Finish setting up your company first" });
      return;
    }

    const phone = toE164(parsed.data.phone);
    if (!phone) {
      res
        .status(400)
        .json({ error: "That doesn't look like a phone number we can text" });
      return;
    }

    const thread = await findOrCreateThread(
      caller.company,
      phone,
      parsed.data.name ?? (await nameForPhone(caller.company, phone)),
    );
    res.json(StartMessageThreadResponse.parse(serializeThread(thread)));
  },
);

router.post(
  "/messages/threads/:id/messages",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = SendClientMessageParams.safeParse(req.params);
    const parsed = SendClientMessageBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({
        error: (params.success ? parsed.error : params.error)!.message,
      });
      return;
    }
    const caller = await getCaller(req);
    if (!caller.company) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const [thread] = await db
      .select()
      .from(clientThreadsTable)
      .where(
        and(
          eq(clientThreadsTable.id, params.data.id),
          eq(clientThreadsTable.companyId, caller.company.id),
        ),
      );
    if (!thread) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const result = await sendClientText(caller.company, {
      toPhone: thread.customerPhone,
      body: parsed.data.body,
      sentByName: caller.name ?? null,
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.reason });
      return;
    }

    const [message] = await db
      .select()
      .from(clientMessagesTable)
      .where(
        and(
          eq(clientMessagesTable.id, result.messageId),
          eq(clientMessagesTable.companyId, caller.company.id),
        ),
      );
    res.json(SendClientMessageResponse.parse(serializeMessage(message!)));
  },
);

/** How many inbound texts are sitting unread, for the sidebar badge. */
router.get(
  "/messages/unread-count",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const caller = await getCaller(req);
    if (!caller.company) {
      res.json({ unread: 0 });
      return;
    }
    const [row] = await db
      .select({
        unread: sql<number>`coalesce(sum(${clientThreadsTable.unreadCount}), 0)::int`,
      })
      .from(clientThreadsTable)
      .where(eq(clientThreadsTable.companyId, caller.company.id));
    res.json({ unread: row?.unread ?? 0 });
  },
);

export default router;
