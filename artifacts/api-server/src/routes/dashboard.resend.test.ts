/**
 * Resending a given-up text after confirming or correcting its destination.
 *
 * The hourly sweep drops an owed text after 3 days and writes a
 * "text_given_up" activity entry carrying the dropped text's payload. The
 * owner can then re-queue it from the dashboard. The payload null-out is the
 * claim, so a double submit queues exactly one text.
 *
 * Same live-app-against-real-DB style as team.notify.test.ts; Clerk is mocked
 * for caller identity, the Quo transport is mocked so tests control sends.
 */
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type http from "node:http";

const { sendMessage, listPhoneNumbers } = vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
  process.env.QUO_API_KEY = "test_platform_key";
  return {
    sendMessage: vi.fn(
      async (
        _apiKey: string,
        _input: { from: string; to: string; content: string },
      ) => ({
        id: "msg_test",
        status: "sent",
        to: [] as string[],
        from: "",
        createdAt: "",
      }),
    ),
    listPhoneNumbers: vi.fn(async () => [{ number: "+15550001111" }]),
  };
});

vi.mock("../lib/quo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/quo")>();
  return { ...actual, sendMessage, listPhoneNumbers };
});

vi.mock("@clerk/express", () => ({
  getAuth: (req: { headers: Record<string, unknown> }) => ({
    userId: (req.headers["x-test-user"] as string | undefined) ?? null,
    sessionClaims: {},
  }),
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  clerkClient: {
    users: {
      getUser: async () => ({ emailAddresses: [] }),
      getUserList: async () => ({ data: [] }),
    },
    invitations: {
      createInvitation: async () => ({ id: "inv_test" }),
      revokeInvitation: async () => ({}),
    },
  },
}));

vi.mock("../middlewares/clerkProxyMiddleware", () => ({
  CLERK_PROXY_PATH: "/__clerk",
  clerkProxyMiddleware:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  getClerkProxyHost: () => null,
}));

import app from "../app";
import {
  db,
  pool,
  companiesTable,
  activityTable,
  pendingTextsTable,
  teamMembersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  retryPendingTexts,
  PENDING_TEXT_MAX_AGE_MS,
  queueTextToSource,
} from "../lib/pendingTexts";
import type { PendingTextSource } from "@workspace/db";

const runId = `${Date.now()}_${process.pid}_resend`;
const OWNER = `resend_owner_${runId}`;

let server: http.Server;
let baseUrl: string;
let companyId: number;

async function call(
  method: string,
  path: string,
  opts: { user?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.user) headers["x-test-user"] = opts.user;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  return fetch(`${baseUrl}/api${path}`, { method, headers, body });
}

/** Seed an expired owed text and sweep it into a "text_given_up" entry. */
async function dropText(input?: {
  toPhone?: string | null;
  kind?: string;
  content?: string;
  source?: PendingTextSource;
}): Promise<number> {
  await db.insert(pendingTextsTable).values({
    companyId,
    toPhone: input?.toPhone === undefined ? "+15551112222" : input.toPhone,
    kind: input?.kind ?? "join_request_approved",
    content: input?.content ?? "You're in!",
    source: input?.source,
    createdAt: new Date(Date.now() - PENDING_TEXT_MAX_AGE_MS - 60 * 60 * 1000),
  });
  await retryPendingTexts();
  const activity = await db
    .select()
    .from(activityTable)
    .where(eq(activityTable.companyId, companyId));
  const dropped = activity.filter((a) => a.type === "text_given_up");
  expect(dropped.length).toBeGreaterThan(0);
  return dropped[dropped.length - 1]!.id;
}

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: OWNER,
      name: `Resend Co ${runId}`,
      timezone: "America/Toronto",
      notificationNumber: "+15559990000",
    })
    .returning();
  companyId = company!.id;

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await db.delete(activityTable).where(eq(activityTable.companyId, companyId));
  await db
    .delete(pendingTextsTable)
    .where(eq(pendingTextsTable.companyId, companyId));
  await db
    .delete(teamMembersTable)
    .where(eq(teamMembersTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

beforeEach(async () => {
  sendMessage.mockClear();
  sendMessage.mockResolvedValue({
    id: "msg_test",
    status: "sent",
    to: [],
    from: "",
    createdAt: "",
  });
  await db
    .delete(pendingTextsTable)
    .where(eq(pendingTextsTable.companyId, companyId));
  await db.delete(activityTable).where(eq(activityTable.companyId, companyId));
});

describe("the give-up entry", () => {
  it("carries the dropped text's payload and shows as resendable in the feed", async () => {
    const entryId = await dropText();
    const [entry] = await db
      .select()
      .from(activityTable)
      .where(eq(activityTable.id, entryId));
    expect(entry!.textPayload).toEqual({
      toPhone: "+15551112222",
      kind: "join_request_approved",
      content: "You're in!",
      source: null,
    });

    const res = await call("GET", "/dashboard/activity", { user: OWNER });
    expect(res.status).toBe(200);
    const feed = (await res.json()) as Array<{
      id: number;
      canResendText?: boolean;
      resendPhone?: string;
    }>;
    const item = feed.find((i) => i.id === entryId);
    expect(item?.canResendText).toBe(true);
    expect(item?.resendPhone).toBe("+15551112222");
  });
});

describe("call entries", () => {
  it("carry callId into the feed so clients can deep-link, and omit it elsewhere", async () => {
    const [withCall] = await db
      .insert(activityTable)
      .values({
        companyId,
        type: "call_answered",
        message: "Call from +15550001111.",
        callId: 987654,
      })
      .returning();
    const [without] = await db
      .insert(activityTable)
      .values({
        companyId,
        type: "call_answered",
        message: "Call from +15550002222.",
      })
      .returning();

    const res = await call("GET", "/dashboard/activity", { user: OWNER });
    expect(res.status).toBe(200);
    const feed = (await res.json()) as Array<{ id: number; callId?: number }>;
    expect(feed.find((i) => i.id === withCall!.id)?.callId).toBe(987654);
    expect(feed.find((i) => i.id === without!.id)?.callId).toBeUndefined();
  });
});

describe("resend", () => {
  it("re-queues and delivers the dropped text with one tap", async () => {
    const entryId = await dropText();
    sendMessage.mockClear();

    const res = await call(
      "POST",
      `/dashboard/activity/${entryId}/resend-text`,
      {
        user: OWNER,
        body: { toPhone: "+15551112222" },
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: true, sourceUpdated: false });

    // Delivered immediately with the original recipient and content.
    const sent = sendMessage.mock.calls.find(
      ([, input]: any[]) => input.to === "+15551112222",
    );
    expect(sent).toBeTruthy();
    expect((sent![1] as any).content).toBe("You're in!");

    // Delivered means nothing left pending, and the entry is spent.
    const pending = await db
      .select()
      .from(pendingTextsTable)
      .where(eq(pendingTextsTable.companyId, companyId));
    expect(pending).toHaveLength(0);
    const feed = (await (
      await call("GET", "/dashboard/activity", { user: OWNER })
    ).json()) as Array<{ id: number; canResendText?: boolean }>;
    expect(feed.find((i) => i.id === entryId)?.canResendText).toBe(false);
  });

  it("delivers to the corrected phone number instead of the original target", async () => {
    const entryId = await dropText();
    sendMessage.mockClear();

    const res = await call(
      "POST",
      `/dashboard/activity/${entryId}/resend-text`,
      {
        user: OWNER,
        body: { toPhone: "+15553334444" },
      },
    );

    expect(res.status).toBe(200);
    expect(
      sendMessage.mock.calls.some(
        ([, input]: any[]) => input.to === "+15553334444",
      ),
    ).toBe(true);
    expect(
      sendMessage.mock.calls.some(
        ([, input]: any[]) => input.to === "+15551112222",
      ),
    ).toBe(false);
  });

  it("saves the correction to the source so a later newly-created text uses it", async () => {
    const [member] = await db
      .insert(teamMembersTable)
      .values({
        companyId,
        name: `Corrected member ${runId}`,
        phone: "+15551112222",
        role: "cleaner",
        status: "active",
      })
      .returning();
    const entryId = await dropText({
      source: { type: "team_member", id: member!.id },
    });

    const feed = (await (
      await call("GET", "/dashboard/activity", { user: OWNER })
    ).json()) as Array<{ id: number; resendSourceLabel?: string }>;
    expect(feed.find((item) => item.id === entryId)?.resendSourceLabel).toBe(
      "team member",
    );

    const res = await call(
      "POST",
      `/dashboard/activity/${entryId}/resend-text`,
      {
        user: OWNER,
        body: { toPhone: "+15553334444", saveToSource: true },
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: true, sourceUpdated: true });

    sendMessage.mockClear();
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    await queueTextToSource(
      company!,
      { type: "team_member", id: member!.id },
      {
        kind: "later_team_text",
        content: "This is a later text.",
      },
    );
    expect(
      sendMessage.mock.calls.some(
        ([, input]: any[]) => input.to === "+15553334444",
      ),
    ).toBe(true);

    await db
      .delete(teamMembersTable)
      .where(eq(teamMembersTable.id, member!.id));
  });

  it("still resends when the original source was deleted", async () => {
    const [member] = await db
      .insert(teamMembersTable)
      .values({
        companyId,
        name: `Deleted member ${runId}`,
        phone: "+15551112222",
        role: "cleaner",
        status: "active",
      })
      .returning();
    const entryId = await dropText({
      source: { type: "team_member", id: member!.id },
    });
    await db
      .delete(teamMembersTable)
      .where(eq(teamMembersTable.id, member!.id));

    const res = await call(
      "POST",
      `/dashboard/activity/${entryId}/resend-text`,
      {
        user: OWNER,
        body: { toPhone: "+15554445555", saveToSource: true },
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: true, sourceUpdated: false });
    expect(
      sendMessage.mock.calls.some(
        ([, input]: any[]) => input.to === "+15554445555",
      ),
    ).toBe(true);
  });

  it("does not update a source record owned by another company", async () => {
    const foreignOwner = `resend_foreign_${runId}`;
    const [foreignCompany] = await db
      .insert(companiesTable)
      .values({
        ownerUserId: foreignOwner,
        name: `Foreign Resend Co ${runId}`,
        timezone: "America/Toronto",
      })
      .returning();
    const [foreignMember] = await db
      .insert(teamMembersTable)
      .values({
        companyId: foreignCompany!.id,
        name: `Foreign member ${runId}`,
        phone: "+15551112222",
        role: "cleaner",
        status: "active",
      })
      .returning();
    const entryId = await dropText({
      source: { type: "team_member", id: foreignMember!.id },
    });

    const res = await call(
      "POST",
      `/dashboard/activity/${entryId}/resend-text`,
      {
        user: OWNER,
        body: { toPhone: "+15556667777", saveToSource: true },
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: true, sourceUpdated: false });

    const [unchanged] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, foreignMember!.id));
    expect(unchanged!.phone).toBe("+15551112222");

    await db
      .delete(teamMembersTable)
      .where(eq(teamMembersTable.id, foreignMember!.id));
    await db
      .delete(companiesTable)
      .where(eq(companiesTable.id, foreignCompany!.id));
  });

  it("ignores malformed source metadata without blocking the resend", async () => {
    const [entry] = await db
      .insert(activityTable)
      .values({
        companyId,
        type: "text_given_up",
        message: "A text needs attention.",
        textPayload: {
          toPhone: "+15551112222",
          kind: "future_kind",
          content: "Still send this.",
          source: { type: "future_source", id: 123 },
        } as never,
      })
      .returning();

    const feed = (await (
      await call("GET", "/dashboard/activity", { user: OWNER })
    ).json()) as Array<{ id: number; resendSourceLabel?: string }>;
    expect(
      feed.find((item) => item.id === entry!.id)?.resendSourceLabel,
    ).toBeUndefined();

    const res = await call(
      "POST",
      `/dashboard/activity/${entry!.id}/resend-text`,
      {
        user: OWNER,
        body: { toPhone: "+15558889999", saveToSource: true },
      },
    );
    expect(res.status).toBe(200);
    expect(
      sendMessage.mock.calls.some(
        ([, input]: any[]) => input.to === "+15558889999",
      ),
    ).toBe(true);
  });

  it("rejects a resend target that is not E.164", async () => {
    const entryId = await dropText();

    const res = await call(
      "POST",
      `/dashboard/activity/${entryId}/resend-text`,
      { user: OWNER, body: { toPhone: "(555) 333-4444" } },
    );

    expect(res.status).toBe(400);
    expect(sendMessage).not.toHaveBeenCalled();
    const [entry] = await db
      .select()
      .from(activityTable)
      .where(eq(activityTable.id, entryId));
    expect(entry?.textPayload).not.toBeNull();
  });

  it("keeps the re-queued text pending (fresh clock) when the send still fails", async () => {
    const entryId = await dropText();
    sendMessage.mockRejectedValue(new Error("quo is still down"));

    const res = await call(
      "POST",
      `/dashboard/activity/${entryId}/resend-text`,
      {
        user: OWNER,
        body: { toPhone: "+15551112222" },
      },
    );
    expect(res.status).toBe(200);

    const pending = await db
      .select()
      .from(pendingTextsTable)
      .where(eq(pendingTextsTable.companyId, companyId));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.content).toBe("You're in!");
    // Fresh createdAt: the 3-day expiry clock restarted at resend time.
    expect(Date.now() - pending[0]!.createdAt.getTime()).toBeLessThan(60_000);

    // Once the transport recovers, the hourly sweep delivers it.
    sendMessage.mockResolvedValue({
      id: "msg_test",
      status: "sent",
      to: [],
      from: "",
      createdAt: "",
    });
    await retryPendingTexts();
    const after = await db
      .select()
      .from(pendingTextsTable)
      .where(eq(pendingTextsTable.companyId, companyId));
    expect(after).toHaveLength(0);
  });

  it("is one-shot: the second tap finds nothing to resend", async () => {
    const entryId = await dropText();
    sendMessage.mockClear();

    const first = await call(
      "POST",
      `/dashboard/activity/${entryId}/resend-text`,
      { user: OWNER, body: { toPhone: "+15551112222" } },
    );
    expect(first.status).toBe(200);
    const second = await call(
      "POST",
      `/dashboard/activity/${entryId}/resend-text`,
      { user: OWNER, body: { toPhone: "+15551112222" } },
    );
    expect(second.status).toBe(404);
    // Exactly one text went out.
    expect(
      sendMessage.mock.calls.filter(
        ([, input]: any[]) => input.to === "+15551112222",
      ),
    ).toHaveLength(1);
  });

  it("leaves the entry resendable (and doesn't claim it) when the queue insert fails", async () => {
    const entryId = await dropText();
    sendMessage.mockClear();

    // Make the pending-text insert inside the resend transaction blow up, so
    // the payload claim rolls back with it instead of being spent for nothing.
    const realTransaction = db.transaction.bind(db);
    const txSpy = vi.spyOn(db, "transaction").mockImplementationOnce(((
      fn: (tx: unknown) => Promise<unknown>,
    ) =>
      realTransaction(async (tx) => {
        const realInsert = tx.insert.bind(tx);
        vi.spyOn(tx, "insert").mockImplementation(((table: unknown) => {
          if (table === pendingTextsTable) throw new Error("db down");
          return realInsert(table as never);
        }) as never);
        return fn(tx);
      })) as never);

    const res = await call(
      "POST",
      `/dashboard/activity/${entryId}/resend-text`,
      { user: OWNER, body: { toPhone: "+15551112222" } },
    );
    txSpy.mockRestore();
    expect(res.status).toBe(500);
    expect(sendMessage).not.toHaveBeenCalled();

    // Nothing queued, payload intact, still offered as resendable.
    const pending = await db
      .select()
      .from(pendingTextsTable)
      .where(eq(pendingTextsTable.companyId, companyId));
    expect(pending).toHaveLength(0);
    const feed = (await (
      await call("GET", "/dashboard/activity", { user: OWNER })
    ).json()) as Array<{ id: number; canResendText?: boolean }>;
    expect(feed.find((i) => i.id === entryId)?.canResendText).toBe(true);

    // A later tap (with a healthy DB) succeeds.
    const retry = await call(
      "POST",
      `/dashboard/activity/${entryId}/resend-text`,
      { user: OWNER, body: { toPhone: "+15551112222" } },
    );
    expect(retry.status).toBe(200);
    expect(
      sendMessage.mock.calls.some(
        ([, input]: any[]) => input.to === "+15551112222",
      ),
    ).toBe(true);
  });

  it("rejects entries that aren't a give-up, unknown ids, and other companies' entries", async () => {
    const [other] = await db
      .insert(activityTable)
      .values({
        companyId,
        type: "booking_created",
        message: "New booking",
      })
      .returning();
    const res = await call(
      "POST",
      `/dashboard/activity/${other!.id}/resend-text`,
      { user: OWNER, body: { toPhone: "+15550003333" } },
    );
    expect(res.status).toBe(404);

    const missing = await call(
      "POST",
      `/dashboard/activity/999999999/resend-text`,
      { user: OWNER, body: { toPhone: "+15550003333" } },
    );
    expect(missing.status).toBe(404);

    const entryId = await dropText();
    const stranger = await call(
      "POST",
      `/dashboard/activity/${entryId}/resend-text`,
      { user: `resend_stranger_${runId}` },
    );
    expect([401, 403, 404]).toContain(stranger.status);
    expect(sendMessage.mock.calls.length).toBe(0);
  });
});
