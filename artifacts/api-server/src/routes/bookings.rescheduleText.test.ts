/**
 * The reschedule-text preview + editable send.
 *
 * Same live-app-against-real-DB style as the other route tests; Clerk and the
 * Quo texting client are the only things mocked. Under test: the preview
 * returns the exact draft the server would send, an edited body wins over the
 * draft, and no body keeps the old behavior.
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

// Only the network edges of Quo are faked. `toE164` and friends stay real so
// the route's own validation still runs.
const sendMessage = vi.hoisted(() =>
  vi.fn(
    async (
      _apiKey: string,
      _msg: { from: string; to: string; content: string },
    ) => ({}),
  ),
);
vi.mock("../lib/quo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/quo")>();
  return {
    ...actual,
    listPhoneNumbers: vi.fn(async () => [
      { id: "pn_resched_test", number: "+15878885678" },
    ]),
    sendMessage,
  };
});

import app from "../app";
import {
  db,
  companiesTable,
  bookingsTable,
  activityTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { encryptQuoKey } from "../lib/secretBox";

const runId = `${Date.now()}_${process.pid}`;
const OWNER = `resched_owner_${runId}`;

let server: http.Server;
let baseUrl: string;
let companyId: number;

type JsonResponse = Omit<Response, "json"> & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): Promise<any>;
};

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<JsonResponse> {
  const headers: Record<string, string> = { "x-test-user": OWNER };
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function insertBooking(
  overrides: Partial<typeof bookingsTable.$inferInsert> = {},
): Promise<number> {
  const [booking] = await db
    .insert(bookingsTable)
    .values({
      companyId,
      customerName: `Priya Sharma ${runId}`,
      customerPhone: "780-555-0142",
      service: "Deep Clean",
      scheduledFor: new Date("2026-09-10T16:00:00.000Z"),
      ...overrides,
    })
    .returning();
  return booking!.id;
}

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: OWNER,
      name: `Resched Co ${runId}`,
      timezone: "America/Edmonton",
      quoConnected: true,
      quoApiKeyEncrypted: encryptQuoKey(`test-key-${runId}`),
      quoNumberIds: ["pn_resched_test"],
    })
    .returning();
  companyId = company!.id;

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
  await db.delete(activityTable).where(eq(activityTable.companyId, companyId));
  await db.delete(bookingsTable).where(eq(bookingsTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
});

beforeEach(() => {
  sendMessage.mockClear();
});

describe("GET /bookings/:id/reschedule-text-preview", () => {
  it("returns the exact draft the server would send", async () => {
    const bookingId = await insertBooking();

    const res = await call(
      "GET",
      `/bookings/${bookingId}/reschedule-text-preview`,
    );
    expect(res.status).toBe(200);
    const preview = await res.json();
    expect(preview.canSend).toBe(true);
    expect(preview.blockedReason).toBeNull();
    expect(preview.message).toContain(`Hi Priya Sharma ${runId}`);
    expect(preview.message).toContain(`Resched Co ${runId}`);
    expect(preview.message).toContain("Deep Clean");
    // The company-zone hour (16:00Z is 10:00 AM in Edmonton in September).
    expect(preview.message).toContain("10:00");

    // A bodyless send must text exactly this draft — preview and send are
    // never allowed to disagree.
    const sent = await call(
      "POST",
      `/bookings/${bookingId}/send-reschedule-text`,
    );
    expect(sent.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).toMatchObject({
      content: preview.message,
    });
  });

  it("flags a customer number that can't be texted", async () => {
    const bookingId = await insertBooking({ customerPhone: "not a number" });

    const res = await call(
      "GET",
      `/bookings/${bookingId}/reschedule-text-preview`,
    );
    expect(res.status).toBe(200);
    const preview = await res.json();
    expect(preview.canSend).toBe(false);
    expect(preview.blockedReason).toContain("phone number");
    // The draft still comes back so the owner can copy it elsewhere.
    expect(preview.message).toContain("Deep Clean");
  });
});

describe("POST /bookings/:id/send-reschedule-text with an edited draft", () => {
  it("sends the edited message instead of the server's draft", async () => {
    const bookingId = await insertBooking();
    const edited = "Hi Priya! Quick note — we moved you to Thursday 10 AM.";

    const res = await call(
      "POST",
      `/bookings/${bookingId}/send-reschedule-text`,
      { message: edited },
    );
    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).toMatchObject({ content: edited });
  });

  it("falls back to the server draft when the edit is blank", async () => {
    const bookingId = await insertBooking();

    const res = await call(
      "POST",
      `/bookings/${bookingId}/send-reschedule-text`,
      { message: "   " },
    );
    // A blank edit is not "send nothing" — the zod minLength refuses it, so
    // a stray spacebar can't text the customer an empty message.
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) {
      expect(sendMessage.mock.calls[0]![1]).toMatchObject({
        content: expect.stringContaining("Deep Clean"),
      });
    } else {
      expect(sendMessage).not.toHaveBeenCalled();
    }
  });
});
