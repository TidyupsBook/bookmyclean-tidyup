/**
 * Staff chat.
 *
 * What matters here is who can read what. Chat is open to every role, so role
 * checks prove nothing on their own — the tests below pin the membership rule
 * (a dispatcher must not be able to open two cleaners' thread), the one-thread
 * rule for a pair, and the fact that posting notifies people in the app rather
 * than by text.
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

const queueText = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../lib/pendingTexts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/pendingTexts")>();
  return { ...actual, queueText };
});

import app from "../app";
import router from "./index";
import {
  db,
  companiesTable,
  teamMembersTable,
  staffConversationsTable,
  staffConversationMembersTable,
  staffMessagesTable,
  type Company,
} from "@workspace/db";
import { eq } from "drizzle-orm";

const runId = `${Date.now()}_${process.pid}`;
const OWNER = `chat_owner_${runId}`;
const DISPATCHER = `chat_dispatcher_${runId}`;
const CLEANER_A = `chat_cleaner_a_${runId}`;
const CLEANER_B = `chat_cleaner_b_${runId}`;
// A cleaner who is on the roster but in no thread — proves that even the
// weakest role is kept out by membership, not by rank.
const CLEANER_C = `chat_cleaner_c_${runId}`;

let server: http.Server;
let baseUrl: string;
let company: Company;
let seats: Record<string, number> = {};

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
      name: `Chat Co ${runId}`,
      timezone: "America/Edmonton",
    })
    .returning();
  company = main!;

  const rows = await db
    .insert(teamMembersTable)
    .values([
      {
        companyId: company.id,
        name: "Owner Olive",
        email: `owner_${runId}@example.com`,
        role: "owner",
        status: "active",
        clerkUserId: OWNER,
        phone: "+15875550101",
      },
      {
        companyId: company.id,
        name: "Dispatch Dana",
        email: `dispatch_${runId}@example.com`,
        role: "dispatcher",
        status: "active",
        clerkUserId: DISPATCHER,
        phone: "+15875550102",
      },
      {
        companyId: company.id,
        name: "Cleaner Cal",
        email: `cleaner_a_${runId}@example.com`,
        role: "cleaner",
        status: "active",
        clerkUserId: CLEANER_A,
        phone: "+15875550103",
      },
      {
        companyId: company.id,
        name: "Cleaner Bev",
        email: `cleaner_b_${runId}@example.com`,
        role: "cleaner",
        status: "active",
        clerkUserId: CLEANER_B,
        phone: null,
      },
      {
        companyId: company.id,
        name: "Cleaner Newt",
        email: `cleaner_c_${runId}@example.com`,
        role: "cleaner",
        status: "active",
        clerkUserId: CLEANER_C,
        phone: null,
      },
    ])
    .returning();
  seats = {
    owner: rows[0]!.id,
    dispatcher: rows[1]!.id,
    cleanerA: rows[2]!.id,
    cleanerB: rows[3]!.id,
    cleanerC: rows[4]!.id,
  };

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
  await db
    .delete(staffMessagesTable)
    .where(eq(staffMessagesTable.companyId, company.id));
  await db
    .delete(staffConversationMembersTable)
    .where(eq(staffConversationMembersTable.companyId, company.id));
  await db
    .delete(staffConversationsTable)
    .where(eq(staffConversationsTable.companyId, company.id));
  await db
    .delete(teamMembersTable)
    .where(eq(teamMembersTable.companyId, company.id));
  await db.delete(companiesTable).where(eq(companiesTable.id, company.id));
});

beforeEach(() => queueText.mockClear());

describe("starting a chat", () => {
  it("gives a pair one thread no matter who opens it", async () => {
    const first = await (
      await call("POST", "/staff-chat/conversations", {
        memberIds: [seats.cleanerA],
      })
    ).json();
    const second = await (
      await call(
        "POST",
        "/staff-chat/conversations",
        { memberIds: [seats.owner] },
        CLEANER_A,
      )
    ).json();

    expect(first.id).toBe(second.id);
    expect(first.kind).toBe("direct");
    expect(first.title).toBe("Cleaner Cal");
  });

  it("lets a cleaner start a group with another cleaner", async () => {
    const res = await call(
      "POST",
      "/staff-chat/conversations",
      { memberIds: [seats.cleanerB, seats.dispatcher], title: "Friday crew" },
      CLEANER_A,
    );
    expect(res.status).toBe(200);
    const conversation = await res.json();
    expect(conversation.kind).toBe("group");
    expect(conversation.title).toBe("Friday crew");
    expect(conversation.memberNames.sort()).toEqual([
      "Cleaner Bev",
      "Dispatch Dana",
    ]);
  });

  it("ignores a staff card from another company", async () => {
    const [rival] = await db
      .insert(companiesTable)
      .values({
        ownerUserId: `chat_rival_${runId}`,
        name: `Chat Rival ${runId}`,
        timezone: "America/Edmonton",
      })
      .returning();
    const [outsider] = await db
      .insert(teamMembersTable)
      .values({
        companyId: rival!.id,
        name: "Outside Otto",
        email: `outsider_${runId}@example.com`,
        role: "cleaner",
        status: "active",
      })
      .returning();

    const res = await call("POST", "/staff-chat/conversations", {
      memberIds: [outsider!.id],
    });
    expect(res.status).toBe(400);

    await db
      .delete(teamMembersTable)
      .where(eq(teamMembersTable.id, outsider!.id));
    await db.delete(companiesTable).where(eq(companiesTable.id, rival!.id));
  });
});

describe("posting a message", () => {
  /**
   * Chat used to text every member who wasn't reading. It doesn't any more —
   * the unread count in the app is the entire notification — and this is the
   * test that keeps a well-meaning "just nudge them" from creeping back in and
   * quietly running up an SMS bill on every line of a back-and-forth.
   */
  it("texts nobody, even the member with a phone who has never opened it", async () => {
    const conversation = await (
      await call("POST", "/staff-chat/conversations", {
        memberIds: [seats.cleanerA, seats.cleanerB],
        title: "Monday",
      })
    ).json();

    const res = await call(
      "POST",
      `/staff-chat/conversations/${conversation.id}/messages`,
      { body: "Running 20 minutes late to the Cedar Court job" },
    );
    expect(res.status).toBe(200);

    expect(queueText).not.toHaveBeenCalled();
  });

  it("counts as unread for everyone else until they open it", async () => {
    const conversation = await (
      await call("POST", "/staff-chat/conversations", {
        memberIds: [seats.cleanerA],
      })
    ).json();

    await call(
      "POST",
      `/staff-chat/conversations/${conversation.id}/messages`,
      { body: "You still on site?" },
    );

    const listFor = async (user: string) => {
      const rows = await (
        await call("GET", "/staff-chat/conversations", undefined, user)
      ).json();
      return rows.find((row: { id: number }) => row.id === conversation.id);
    };

    // The writer is never chased about their own message.
    expect((await listFor(OWNER)).unreadCount).toBe(0);
    expect((await listFor(CLEANER_A)).unreadCount).toBe(1);

    // Opening the thread is what clears it — nothing else does.
    await call(
      "GET",
      `/staff-chat/conversations/${conversation.id}`,
      undefined,
      CLEANER_A,
    );
    expect((await listFor(CLEANER_A)).unreadCount).toBe(0);
  });

  it("rejects an empty message", async () => {
    const conversation = await (
      await call("POST", "/staff-chat/conversations", {
        memberIds: [seats.dispatcher],
      })
    ).json();
    const res = await call(
      "POST",
      `/staff-chat/conversations/${conversation.id}/messages`,
      { body: "   " },
    );
    expect(res.status).toBe(400);
  });
});

describe("who can read a conversation", () => {
  it("hides a thread from someone who isn't in it, whatever their role", async () => {
    const conversation = await (
      await call(
        "POST",
        "/staff-chat/conversations",
        { memberIds: [seats.cleanerB] },
        CLEANER_A,
      )
    ).json();

    // A dispatcher outranks a cleaner and still cannot read their thread.
    const read = await call(
      "GET",
      `/staff-chat/conversations/${conversation.id}`,
      undefined,
      DISPATCHER,
    );
    expect(read.status).toBe(404);

    const write = await call(
      "POST",
      `/staff-chat/conversations/${conversation.id}/messages`,
      { body: "Butting in" },
      DISPATCHER,
    );
    expect(write.status).toBe(404);
  });

  it("counts unread messages and clears them when opened", async () => {
    // A pair that hasn't talked yet, so the count starts from a clean slate.
    const conversation = await (
      await call("POST", "/staff-chat/conversations", {
        memberIds: [seats.cleanerB],
      })
    ).json();
    await call(
      "POST",
      `/staff-chat/conversations/${conversation.id}/messages`,
      { body: "Keys are under the mat" },
    );

    const beforeOpen = await (
      await call("GET", "/staff-chat/conversations", undefined, CLEANER_B)
    ).json();
    expect(
      beforeOpen.find((c: { id: number }) => c.id === conversation.id)
        .unreadCount,
    ).toBe(1);

    await call(
      "GET",
      `/staff-chat/conversations/${conversation.id}`,
      undefined,
      CLEANER_B,
    );

    const afterOpen = await (
      await call("GET", "/staff-chat/conversations", undefined, CLEANER_B)
    ).json();
    expect(
      afterOpen.find((c: { id: number }) => c.id === conversation.id)
        .unreadCount,
    ).toBe(0);
    // The writer never has unread messages of their own.
    const mine = await (await call("GET", "/staff-chat/conversations")).json();
    expect(
      mine.find((c: { id: number }) => c.id === conversation.id).unreadCount,
    ).toBe(0);
  });

  it("lists teammates to start a chat with, minus yourself", async () => {
    const contacts = await (
      await call("GET", "/staff-chat/contacts", undefined, CLEANER_A)
    ).json();
    const names = contacts.map((c: { name: string }) => c.name);
    expect(names).toContain("Cleaner Bev");
    expect(names).toContain("Owner Olive");
    expect(names).not.toContain("Cleaner Cal");
  });
});

/**
 * Membership matrix for every staff-chat route.
 *
 * Chat routes are open to every role, so the role guard proves nothing about
 * one conversation — membership is the only fence. This block walks the live
 * router and fails when a staff-chat route exists that the lists below do not
 * mention, so a new route added without a membership check is caught here
 * rather than shipping open.
 */
describe("staff-chat membership matrix", () => {
  /**
   * Routes scoped to one conversation: a caller who is not a member must get
   * a 404 that reads exactly like the thread not existing. `body` is a valid
   * request body so the call reaches the membership check instead of dying
   * on validation.
   */
  const CONVERSATION_ROUTES: Record<string, { body?: unknown }> = {
    "GET /staff-chat/conversations/:id": {},
    "POST /staff-chat/conversations/:id/messages": {
      body: { body: "Trying to butt in" },
    },
  };

  /**
   * Routes that are not about one conversation (listing your own threads,
   * picking a contact, starting a thread). Nothing to be a member OF — but
   * they still must be enumerated so a new route lands in one list or the
   * other on purpose.
   */
  const ROSTER_ROUTES = new Set<string>([
    "GET /staff-chat/conversations",
    "POST /staff-chat/conversations",
    "GET /staff-chat/contacts",
  ]);

  /** Every /staff-chat route the live router actually serves. */
  function liveStaffChatRoutes(): Set<string> {
    const found = new Set<string>();
    type Layer = {
      route?: { path: string | string[]; methods: Record<string, boolean> };
      handle?: { stack?: Layer[] };
    };
    const walk = (layers: Layer[]) => {
      for (const layer of layers) {
        if (layer.route) {
          const paths = Array.isArray(layer.route.path)
            ? layer.route.path
            : [layer.route.path];
          for (const [method, on] of Object.entries(layer.route.methods)) {
            if (!on) continue;
            for (const p of paths) {
              if (p.startsWith("/staff-chat")) {
                found.add(`${method.toUpperCase()} ${p}`);
              }
            }
          }
        } else if (layer.handle?.stack) {
          walk(layer.handle.stack);
        }
      }
    };
    walk((router as unknown as { stack: Layer[] }).stack);
    return found;
  }

  it("every live staff-chat route is accounted for — a new route without a membership expectation fails here", () => {
    const live = liveStaffChatRoutes();
    const known = new Set([
      ...Object.keys(CONVERSATION_ROUTES),
      ...ROSTER_ROUTES,
    ]);

    const unaccounted = [...live].filter((r) => !known.has(r));
    expect(
      unaccounted,
      `New staff-chat route(s) with no membership expectation. Add each to ` +
        `CONVERSATION_ROUTES (and make the handler 404 for non-members) or to ` +
        `ROSTER_ROUTES if it is genuinely not about one conversation: ` +
        unaccounted.join(", "),
    ).toEqual([]);

    const stale = [...known].filter((r) => !live.has(r));
    expect(
      stale,
      `Membership matrix mentions route(s) the router no longer serves: ` +
        stale.join(", "),
    ).toEqual([]);

    // A conversation route without an :id would be checking membership of
    // nothing — catch a rename that silently drops the parameter.
    for (const route of Object.keys(CONVERSATION_ROUTES)) {
      expect(route, `${route} must address one conversation by :id`).toContain(
        ":id",
      );
    }
  });

  // Every role that is NOT in the thread — including the owner, who outranks
  // everyone and still may not read a crew's chat.
  const NON_MEMBERS: Array<[label: string, user: string]> = [
    ["owner", OWNER],
    ["dispatcher", DISPATCHER],
    ["another cleaner", CLEANER_C],
  ];

  for (const [key, { body }] of Object.entries(CONVERSATION_ROUTES)) {
    const [method, path] = key.split(" ") as [string, string];
    for (const [label, user] of NON_MEMBERS) {
      it(`${key} answers 404 to a non-member ${label}`, async () => {
        // A private thread between the two cleaners; nobody else is in it.
        const conversation = await (
          await call(
            "POST",
            "/staff-chat/conversations",
            { memberIds: [seats.cleanerB] },
            CLEANER_A,
          )
        ).json();

        const res = await call(
          method,
          path.replace(":id", String(conversation.id)),
          body,
          user,
        );
        expect(res.status).toBe(404);
      });
    }
  }

  for (const [key, { body }] of Object.entries(CONVERSATION_ROUTES)) {
    const [method, path] = key.split(" ") as [string, string];
    it(`${key} still lets a member through`, async () => {
      const conversation = await (
        await call(
          "POST",
          "/staff-chat/conversations",
          { memberIds: [seats.cleanerB] },
          CLEANER_A,
        )
      ).json();
      const res = await call(
        method,
        path.replace(":id", String(conversation.id)),
        body,
        CLEANER_A,
      );
      expect(res.status).toBe(200);
    });
  }
});

/**
 * The boss's phone, tablet and PC can each be an owner card of their own. The
 * account that owns the company still has to speak as itself in chat rather
 * than borrowing whichever device card sorts first.
 */
describe("a company with several owner cards", () => {
  it("keeps the company account on its own card", async () => {
    // A device card that is also an owner, and has a login of its own.
    const [device] = await db
      .insert(teamMembersTable)
      .values({
        companyId: company.id,
        name: "Boss iPad",
        email: `boss_ipad_${runId}@example.com`,
        role: "owner",
        status: "active",
        clerkUserId: `chat_ipad_${runId}`,
        phone: null,
      })
      .returning();

    // The company's own card is the login-less one made with the company, so
    // point the existing owner card at nothing and let the account fall back.
    await db
      .update(teamMembersTable)
      .set({ clerkUserId: null })
      .where(eq(teamMembersTable.id, seats.owner!));

    try {
      // Chatting to a cleaner as the company account lands in the company
      // card's thread, not the tablet's.
      const started = await (
        await call("POST", "/staff-chat/conversations", {
          memberIds: [seats.cleanerA],
        })
      ).json();
      const members = await db
        .select()
        .from(staffConversationMembersTable)
        .where(
          eq(
            staffConversationMembersTable.conversationId,
            started.id as number,
          ),
        );
      const ids = members.map((m) => m.memberId);
      expect(ids).toContain(seats.owner);
      expect(ids).not.toContain(device!.id);
    } finally {
      await db
        .update(teamMembersTable)
        .set({ clerkUserId: OWNER })
        .where(eq(teamMembersTable.id, seats.owner!));
      await db
        .delete(teamMembersTable)
        .where(eq(teamMembersTable.id, device!.id));
    }
  });
});
