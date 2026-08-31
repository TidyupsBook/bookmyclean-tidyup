/**
 * Two-way customer texting.
 *
 * The things worth pinning here are the ones that would quietly corrupt a
 * conversation: a redelivered webhook duplicating what the customer said, a
 * failed send disappearing instead of being shown, and one company reading
 * another's thread by guessing an id.
 */
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type http from "node:http";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
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
      getUser: async () => ({
        emailAddresses: [],
        firstName: "Test",
        lastName: "User",
      }),
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

const sendMessage = vi.hoisted(() =>
  vi.fn(async () => ({ id: "msg_out_default" })),
);
vi.mock("../lib/quo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/quo")>();
  return {
    ...actual,
    listPhoneNumbers: vi.fn(async () => [
      { id: "pn_messages_test", number: "+15878884321" },
    ]),
    sendMessage,
  };
});

import app from "../app";
import {
  db,
  companiesTable,
  bookingsTable,
  clientThreadsTable,
  clientMessagesTable,
  type Company,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { encryptQuoKey } from "../lib/secretBox";
import { recordInboundMessage, sendClientText } from "../lib/clientMessaging";

const runId = `${Date.now()}_${process.pid}`;
const OWNER = `messages_owner_${runId}`;
const OTHER_OWNER = `messages_other_${runId}`;
const CUSTOMER = "+17805550188";

let server: http.Server;
let baseUrl: string;
let company: Company;
let otherCompany: Company;

type JsonResponse = Omit<Response, "json"> & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): Promise<any>;
};

async function call(
  method: string,
  path: string,
  body?: unknown,
  user = OWNER,
): Promise<JsonResponse> {
  const headers: Record<string, string> = { "x-test-user": user };
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  const [main] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: OWNER,
      name: `Messages Co ${runId}`,
      timezone: "America/Edmonton",
      quoConnected: true,
      quoApiKeyEncrypted: encryptQuoKey(`test-key-${runId}`),
      quoNumberIds: ["pn_messages_test"],
    })
    .returning();
  company = main!;

  const [other] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: OTHER_OWNER,
      name: `Messages Rival ${runId}`,
      timezone: "America/Edmonton",
    })
    .returning();
  otherCompany = other!;

  // A booking gives the inbox a name to put on the number.
  await db.insert(bookingsTable).values({
    companyId: company.id,
    customerName: `Dana Whitecloud ${runId}`,
    customerPhone: CUSTOMER,
    service: "Deep Clean",
    scheduledFor: new Date("2026-09-14T16:00:00.000Z"),
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  for (const id of [company.id, otherCompany.id]) {
    await db
      .delete(clientMessagesTable)
      .where(eq(clientMessagesTable.companyId, id));
    await db
      .delete(clientThreadsTable)
      .where(eq(clientThreadsTable.companyId, id));
    await db.delete(bookingsTable).where(eq(bookingsTable.companyId, id));
    await db.delete(companiesTable).where(eq(companiesTable.id, id));
  }
});

beforeEach(() => {
  sendMessage.mockClear();
  sendMessage.mockImplementation(async () => ({ id: `msg_${Date.now()}` }));
});

describe("inbound customer texts", () => {
  it("starts a thread, names it from the booking, and counts it unread", async () => {
    const result = await recordInboundMessage(company, {
      fromPhone: CUSTOMER,
      body: "Can you come Friday instead?",
      quoMessageId: `in_${runId}_1`,
    });
    expect(result).not.toBeNull();

    const [thread] = await db
      .select()
      .from(clientThreadsTable)
      .where(eq(clientThreadsTable.id, result!.threadId));
    expect(thread!.customerName).toContain("Dana Whitecloud");
    expect(thread!.unreadCount).toBe(1);
    expect(thread!.lastDirection).toBe("inbound");
    expect(thread!.lastMessagePreview).toBe("Can you come Friday instead?");
  });

  it("ignores a redelivered webhook instead of saying it twice", async () => {
    const first = await recordInboundMessage(company, {
      fromPhone: CUSTOMER,
      body: "Second thoughts — make it Saturday",
      quoMessageId: `in_${runId}_dupe`,
    });
    const second = await recordInboundMessage(company, {
      fromPhone: CUSTOMER,
      body: "Second thoughts — make it Saturday",
      quoMessageId: `in_${runId}_dupe`,
    });

    expect(first).not.toBeNull();
    // A repeat delivery is normal, not an error — it simply adds nothing.
    expect(second).toBeNull();

    const rows = await db
      .select()
      .from(clientMessagesTable)
      .where(eq(clientMessagesTable.quoMessageId, `in_${runId}_dupe`));
    expect(rows).toHaveLength(1);
  });
});

describe("replying", () => {
  it("sends from the company line and files the reply in the thread", async () => {
    const opened = await call("POST", "/messages/threads", {
      phone: CUSTOMER,
    });
    expect(opened.status).toBe(200);
    const thread = await opened.json();

    const res = await call("POST", `/messages/threads/${thread.id}/messages`, {
      body: "Saturday at 9 works — see you then!",
    });
    expect(res.status).toBe(200);
    const message = await res.json();
    expect(message.direction).toBe("outbound");
    expect(message.status).toBe("sent");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const args = (sendMessage.mock.calls[0] as unknown as unknown[])[1] as {
      from: string;
      to: string;
      content: string;
    };
    expect(args.from).toBe("+15878884321");
    expect(args.to).toBe(CUSTOMER);
    expect(args.content).toBe("Saturday at 9 works — see you then!");
  });

  it("keeps a failed reply visible instead of losing the words", async () => {
    sendMessage.mockImplementation(async () => {
      throw new Error("Quo says that number is unreachable");
    });

    const result = await sendClientText(company, {
      toPhone: CUSTOMER,
      body: "Are you still there?",
    });
    expect(result.ok).toBe(false);

    const rows = await db
      .select()
      .from(clientMessagesTable)
      .where(eq(clientMessagesTable.companyId, company.id));
    const failed = rows.find((r) => r.body === "Are you still there?");
    expect(failed?.status).toBe("failed");
    expect(failed?.errorText).toContain("unreachable");
  });

  it("refuses a number it cannot text", async () => {
    const res = await call("POST", "/messages/threads", { phone: "12345" });
    expect(res.status).toBe(400);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("reading the inbox", () => {
  it("clears the unread badge when the conversation is opened", async () => {
    const inbound = await recordInboundMessage(company, {
      fromPhone: CUSTOMER,
      body: "One more thing",
      quoMessageId: `in_${runId}_read`,
    });

    const res = await call("GET", `/messages/threads/${inbound!.threadId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.thread.unreadCount).toBe(0);
    expect(body.messages.length).toBeGreaterThan(0);

    const count = await (await call("GET", "/messages/unread-count")).json();
    expect(count.unread).toBe(0);
  });

  it("hides another company's conversation behind a 404", async () => {
    const foreign = await recordInboundMessage(otherCompany, {
      fromPhone: "+17805550199",
      body: "Wrong company's customer",
      quoMessageId: `in_${runId}_foreign`,
    });

    const res = await call("GET", `/messages/threads/${foreign!.threadId}`);
    expect(res.status).toBe(404);

    const reply = await call(
      "POST",
      `/messages/threads/${foreign!.threadId}/messages`,
      { body: "Hello?" },
    );
    expect(reply.status).toBe(404);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
