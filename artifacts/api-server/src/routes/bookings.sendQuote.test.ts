/**
 * The price-mismatch guard on POST /bookings/:id/send-quote.
 *
 * Same live-app-against-real-DB style as the other route tests; Clerk and the
 * Quo texting client are the only things mocked. What's under test is the
 * refusal path: a hand-edited draft that no longer quotes the calculated price
 * must be rejected until the dispatcher explicitly confirms the mismatch —
 * and the confirmed send must freeze the totals the booking actually records.
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
const sendMessage = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../lib/quo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/quo")>();
  return {
    ...actual,
    listPhoneNumbers: vi.fn(async () => [
      { id: "pn_sendquote_test", number: "+15878881234" },
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
const OWNER = `sendquote_owner_${runId}`;

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

/**
 * A booking priced with the calculator: 2h × $75 = $150 subtotal, then the
 * company's 5% tax and 7.5% fees → $168.75 total. Deposit varies per test.
 */
async function insertBooking(quoteDeposit: number): Promise<number> {
  const [booking] = await db
    .insert(bookingsTable)
    .values({
      companyId,
      customerName: `Priya Sharma ${runId}`,
      customerPhone: "780-555-0142",
      service: "Deep Clean",
      scheduledFor: new Date("2026-09-10T16:00:00.000Z"),
      quoteHours: 2,
      quoteHourlyRate: 75,
      quoteFuelSurcharge: 0,
      quoteDeposit,
    })
    .returning();
  return booking!.id;
}

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: OWNER,
      name: `SendQuote Co ${runId}`,
      timezone: "America/Edmonton",
      quoConnected: true,
      quoApiKeyEncrypted: encryptQuoKey(`test-key-${runId}`),
      quoNumberIds: ["pn_sendquote_test"],
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

describe("POST /bookings/:id/send-quote price-mismatch guard", () => {
  it("refuses an unconfirmed message that no longer quotes the price", async () => {
    const bookingId = await insertBooking(0);

    const res = await call("POST", `/bookings/${bookingId}/send-quote`, {
      message: "Hey Priya! Your total is $175.00 — see the link below.",
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    // The refusal names the figure the booking will actually record.
    expect(body.error).toContain("$168.75");
    // Nothing was texted and nothing was recorded.
    expect(sendMessage).not.toHaveBeenCalled();
    const [booking] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, bookingId));
    expect(booking!.quoteSentAt).toBeNull();
    expect(booking!.quoteSentTotals).toBeNull();
  });

  it("accepts the same mismatched message once the dispatcher confirms", async () => {
    const bookingId = await insertBooking(0);

    const res = await call("POST", `/bookings/${bookingId}/send-quote`, {
      message: "Hey Priya! Your total is $175.00 — see the link below.",
      confirmPriceMismatch: true,
    });

    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // The frozen copy records the CALCULATED price, not the edited text's —
    // that is the whole discrepancy the guard exists to make deliberate.
    const [booking] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, bookingId));
    expect(booking!.quoteSentAt).not.toBeNull();
    expect(booking!.quoteSentTotals?.total).toBe(168.75);
  });

  it("sends without confirmation when the message still quotes the price", async () => {
    const bookingId = await insertBooking(0);

    const res = await call("POST", `/bookings/${bookingId}/send-quote`, {
      message: "Hey Priya! Your total is $168.75 — see the link below.",
    });

    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("anchors on the deposit when there is one — the total alone is refused", async () => {
    const bookingId = await insertBooking(50);

    const totalOnly = await call("POST", `/bookings/${bookingId}/send-quote`, {
      message: "Hey Priya! Your total is $168.75 — see the link below.",
    });
    expect(totalOnly.status).toBe(409);
    expect((await totalOnly.json()).error).toContain("$50.00");
    expect(sendMessage).not.toHaveBeenCalled();

    const depositLed = await call("POST", `/bookings/${bookingId}/send-quote`, {
      message: "Hey Priya! Your deposit amount: $50.00 — see the link below.",
    });
    expect(depositLed.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
