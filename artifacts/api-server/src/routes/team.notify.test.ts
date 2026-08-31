/**
 * The texts around a join request: the owner hears somebody is waiting, the
 * applicant hears the verdict — and a failed send is owed, not lost.
 *
 * Same live-app-against-real-DB style as team.test.ts; Clerk is mocked for
 * caller identity, and the Quo transport (sendMessage/listPhoneNumbers) is
 * mocked so tests control whether a send succeeds.
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
  teamMembersTable,
  activityTable,
  pendingTextsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  retryPendingTexts,
  PENDING_TEXT_MAX_AGE_MS,
} from "../lib/pendingTexts";

const runId = `${Date.now()}_${process.pid}_notify`;
const OWNER = `notify_owner_${runId}`;

let server: http.Server;
let baseUrl: string;
let companyId: number;
let joinCode: string;
let applicantSeq = 0;

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

/** File a join request as a fresh applicant; returns their pending seat id. */
async function fileRequest(phone?: string): Promise<number> {
  const user = `notify_applicant_${runId}_${applicantSeq++}`;
  const res = await call("POST", "/team/join-requests", {
    user,
    body: {
      joinCode,
      name: `Applicant ${applicantSeq}`,
      ...(phone ? { phone } : {}),
    },
  });
  expect(res.status).toBe(201);
  const [row] = await db
    .select({ id: teamMembersTable.id })
    .from(teamMembersTable)
    .where(eq(teamMembersTable.clerkUserId, user));
  return row!.id;
}

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: OWNER,
      name: `Notify Co ${runId}`,
      timezone: "America/Toronto",
      notificationNumber: "+15559990000",
      joinCode: `N${runId.slice(-5).toUpperCase()}`,
    })
    .returning();
  companyId = company!.id;
  joinCode = company!.joinCode!;

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await db.delete(activityTable).where(eq(activityTable.companyId, companyId));
  await db
    .delete(teamMembersTable)
    .where(eq(teamMembersTable.companyId, companyId));
  await db
    .delete(pendingTextsTable)
    .where(eq(pendingTextsTable.companyId, companyId));
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
});

describe("a join request arriving", () => {
  it("texts the owner at their notification number, and leaves nothing pending", async () => {
    await fileRequest();
    const ownerText = sendMessage.mock.calls.find(
      ([, input]: any[]) => input.to === "+15559990000",
    );
    expect(ownerText).toBeTruthy();
    expect((ownerText![1] as any).content).toContain("asked to join");
    const pending = await db
      .select()
      .from(pendingTextsTable)
      .where(eq(pendingTextsTable.companyId, companyId));
    expect(pending).toHaveLength(0);
  });

  it("keeps the owner text pending when the send fails, and the sweep retries it", async () => {
    sendMessage.mockRejectedValue(new Error("quo is down"));
    await fileRequest();
    const pending = await db
      .select()
      .from(pendingTextsTable)
      .where(eq(pendingTextsTable.companyId, companyId));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.kind).toBe("join_request_owner");

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
    expect(
      sendMessage.mock.calls.some(
        ([, input]: any[]) => input.to === "+15559990000",
      ),
    ).toBe(true);
  });
});

describe("the verdict", () => {
  it("texts the applicant they're in when approved", async () => {
    const seatId = await fileRequest("555-123-4567");
    sendMessage.mockClear();
    const res = await call("POST", `/team/${seatId}/approve`, {
      user: OWNER,
      body: { role: "cleaner" },
    });
    expect(res.status).toBe(200);
    const text = sendMessage.mock.calls.find(
      ([, input]: any[]) => input.to === "+15551234567",
    );
    expect(text).toBeTruthy();
    expect((text![1] as any).content).toContain("approved");
  });

  it("texts the applicant plainly when declined, even though the seat is gone", async () => {
    const seatId = await fileRequest("555-765-4321");
    sendMessage.mockClear();
    const res = await call("POST", `/team/${seatId}/decline`, { user: OWNER });
    expect(res.status).toBe(200);
    const text = sendMessage.mock.calls.find(
      ([, input]: any[]) => input.to === "+15557654321",
    );
    expect(text).toBeTruthy();
    expect((text![1] as any).content).toContain("didn't approve");
    // The seat really is gone — the text was queued from the deleted row.
    const [seat] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, seatId));
    expect(seat).toBeUndefined();
  });

  it("keeps a failed approval text pending for the sweep, without undoing the approval", async () => {
    const seatId = await fileRequest("555-222-3333");
    sendMessage.mockClear();
    sendMessage.mockRejectedValue(new Error("quo is down"));
    const res = await call("POST", `/team/${seatId}/approve`, {
      user: OWNER,
      body: { role: "cleaner" },
    });
    expect(res.status).toBe(200);

    // The approval held even though the text didn't go.
    const [seat] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, seatId));
    expect(seat!.status).toBe("active");

    const pending = await db
      .select()
      .from(pendingTextsTable)
      .where(eq(pendingTextsTable.companyId, companyId));
    expect(pending.map((p) => p.kind)).toContain("join_request_approved");
  });

  it("approves without a text when the applicant left no phone number", async () => {
    const seatId = await fileRequest();
    sendMessage.mockClear();
    const res = await call("POST", `/team/${seatId}/approve`, {
      user: OWNER,
      body: { role: "cleaner" },
    });
    expect(res.status).toBe(200);
    expect(sendMessage).not.toHaveBeenCalled();
    const pending = await db
      .select()
      .from(pendingTextsTable)
      .where(eq(pendingTextsTable.companyId, companyId));
    expect(pending).toHaveLength(0);
  });
});

describe("the hourly sweep", () => {
  it("drops an expired owed text instead of sending it weeks late", async () => {
    const [stale] = await db
      .insert(pendingTextsTable)
      .values({
        companyId,
        toPhone: "+15551112222",
        kind: "join_request_approved",
        content: "You're in!",
        createdAt: new Date(
          Date.now() - PENDING_TEXT_MAX_AGE_MS - 60 * 60 * 1000,
        ),
      })
      .returning();
    expect(stale).toBeTruthy();
    sendMessage.mockClear();

    await retryPendingTexts();

    // Removed, but never sent.
    const after = await db
      .select()
      .from(pendingTextsTable)
      .where(eq(pendingTextsTable.companyId, companyId));
    expect(after).toHaveLength(0);
    expect(sendMessage).not.toHaveBeenCalled();

    // The give-up is surfaced to the owner as a dashboard activity entry.
    const activity = await db
      .select()
      .from(activityTable)
      .where(eq(activityTable.companyId, companyId));
    const dropped = activity.filter((a) => a.type === "text_given_up");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.message).toContain("+15551112222");
    expect(dropped[0]!.message).toContain("join request approved");
  });

  it("keeps the expired text for a later sweep when the activity write fails", async () => {
    await db.insert(pendingTextsTable).values({
      companyId,
      toPhone: "+15556667777",
      kind: "join_request_approved",
      content: "You're in!",
      createdAt: new Date(
        Date.now() - PENDING_TEXT_MAX_AGE_MS - 60 * 60 * 1000,
      ),
    });
    sendMessage.mockClear();

    // Make the activity insert inside the drop transaction blow up, so the
    // whole drop rolls back instead of silently losing the notification.
    const realTransaction = db.transaction.bind(db);
    const txSpy = vi.spyOn(db, "transaction").mockImplementationOnce(((
      fn: (tx: unknown) => Promise<unknown>,
    ) =>
      realTransaction(async (tx) => {
        const realInsert = tx.insert.bind(tx);
        vi.spyOn(tx, "insert").mockImplementation(((table: unknown) => {
          if (table === activityTable) throw new Error("db down");
          return realInsert(table as never);
        }) as never);
        return fn(tx);
      })) as never);

    await retryPendingTexts();
    txSpy.mockRestore();

    // Neither sent late nor dropped: still queued for the next sweep.
    expect(sendMessage).not.toHaveBeenCalled();
    const after = await db
      .select()
      .from(pendingTextsTable)
      .where(eq(pendingTextsTable.companyId, companyId));
    expect(after).toHaveLength(1);
    const activity = await db
      .select()
      .from(activityTable)
      .where(eq(activityTable.companyId, companyId));
    expect(
      activity.filter(
        (a) => a.type === "text_given_up" && a.message.includes("+15556667777"),
      ),
    ).toHaveLength(0);

    // A later sweep (with a healthy DB) completes the drop-and-announce.
    await retryPendingTexts();
    expect(sendMessage).not.toHaveBeenCalled();
    const finallyDropped = await db
      .select()
      .from(pendingTextsTable)
      .where(eq(pendingTextsTable.companyId, companyId));
    expect(finallyDropped).toHaveLength(0);
    const announced = await db
      .select()
      .from(activityTable)
      .where(eq(activityTable.companyId, companyId));
    expect(
      announced.filter(
        (a) => a.type === "text_given_up" && a.message.includes("+15556667777"),
      ),
    ).toHaveLength(1);
  });

  it("still sends a text that is old but inside the expiry window", async () => {
    await db.insert(pendingTextsTable).values({
      companyId,
      toPhone: "+15553334444",
      kind: "join_request_approved",
      content: "You're in!",
      createdAt: new Date(
        Date.now() - PENDING_TEXT_MAX_AGE_MS + 60 * 60 * 1000,
      ),
    });
    sendMessage.mockClear();

    await retryPendingTexts();

    const after = await db
      .select()
      .from(pendingTextsTable)
      .where(eq(pendingTextsTable.companyId, companyId));
    expect(after).toHaveLength(0);
    expect(
      sendMessage.mock.calls.some(
        ([, input]: any[]) => input.to === "+15553334444",
      ),
    ).toBe(true);
  });
});
