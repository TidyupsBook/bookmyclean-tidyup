/**
 * Public request form intake tests.
 *
 * Same live-app-against-real-DB style as the other route tests. There is no
 * caller identity at all here — the whole point of the endpoint is that a
 * stranger clicking an ad submits without signing in — so the Clerk mock
 * exists only to satisfy app.ts, never to authenticate anyone.
 *
 * The endpoint attributes every submission to the deployment's lead company,
 * which this test seeds with a notification number and resolves through the
 * same service seam as production. The test cleans up only its run-unique
 * company and the rows it created.
 *
 * The Quo transport is mocked so the owner-notify path runs fully (including
 * the pending_texts insert and claim) without touching a real API, and
 * afterAll sweeps any leftover pending_texts rows for this company.
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

const { sendMessage, listPhoneNumbers, leadsCompanyIdMock } = vi.hoisted(() => {
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
    leadsCompanyIdMock: vi.fn<() => Promise<number | null>>(async () => null),
  };
});

vi.mock("../lib/quo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/quo")>();
  return { ...actual, sendMessage, listPhoneNumbers };
});

vi.mock("../services/leadsSync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/leadsSync")>();
  return { ...actual, leadsCompanyId: leadsCompanyIdMock };
});

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: null, sessionClaims: {} }),
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  clerkClient: { users: { getUser: async () => ({ emailAddresses: [] }) } },
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
  leadsTable,
  activityTable,
  companiesTable,
  pendingTextsTable,
} from "@workspace/db";
import { and, eq, like } from "drizzle-orm";
import { resetRateLimits } from "../lib/rateLimit";
import { FORM_SOURCE_TAB } from "./publicRequest";

const runId = `${Date.now()}_${process.pid}`;
const EMAIL = (tag: string) => `request_${tag}_${runId}@test.invalid`;

let server: http.Server;
let baseUrl: string;
let companyId: number;

async function submit(
  body: Record<string, unknown>,
  opts: { address?: string } = {},
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // No auth header of any kind — every request in this file is anonymous.
    "x-forwarded-for": opts.address ?? `10.9.${runId.slice(-2)}.1`,
  };
  return fetch(`${baseUrl}/api/request`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function ourLeads(email: string) {
  return db
    .select()
    .from(leadsTable)
    .where(
      and(eq(leadsTable.companyId, companyId), eq(leadsTable.email, email)),
    );
}

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `request_owner_${runId}`,
      name: `Request Co ${runId}`,
      timezone: "America/Toronto",
      notificationNumber: "+15559990000",
    })
    .returning({ id: companiesTable.id });
  companyId = company!.id;
  leadsCompanyIdMock.mockResolvedValue(companyId);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Only what this run created.
  await db.delete(leadsTable).where(eq(leadsTable.companyId, companyId));
  await db.delete(activityTable).where(eq(activityTable.companyId, companyId));
  await db
    .delete(pendingTextsTable)
    .where(eq(pendingTextsTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end();
});

beforeEach(async () => {
  // Every test shares one process-wide limiter; a previous test's
  // submissions must never be the reason a later one sees 429.
  resetRateLimits();
  sendMessage.mockClear();
  sendMessage.mockResolvedValue({
    id: "msg_test",
    status: "sent",
    to: [],
    from: "",
    createdAt: "",
  });
  listPhoneNumbers.mockClear();
  await db
    .delete(pendingTextsTable)
    .where(eq(pendingTextsTable.companyId, companyId));
});

describe("a customer's submission", () => {
  it("creates exactly one lead, verbatim, with no sign-in anywhere", async () => {
    const res = await submit({
      firstName: "Nadia",
      lastName: `Form_${runId}`,
      phone: " (780) 555-0142 ",
      email: EMAIL("ok"),
      streetAddress: "44 Alder Bend",
      city: "Edmonton",
      province: "AB",
      postCode: "T6W 1A1",
      service: "Deep cleaning",
      bedrooms: "1 or 2",
      bathrooms: "2",
      dateOfServiceRequested: "sometime next weekend?",
      heardAbout: "Friend or family",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });

    const rows = await ourLeads(EMAIL("ok"));
    expect(rows).toHaveLength(1);
    const lead = rows[0]!;
    // Marked as ours, not the ad sheet's.
    expect(lead.source).toBe("form");
    expect(lead.sourceTab).toBe(FORM_SOURCE_TAB);
    expect(lead.externalId).toMatch(/^form_/);
    expect(lead.status).toBe("new");
    // Verbatim — the padding on the phone, the "1 or 2", the question mark.
    expect(lead.phoneNumber).toBe(" (780) 555-0142 ");
    expect(lead.bedrooms).toBe("1 or 2");
    expect(lead.dateOfServiceRequested).toBe("sometime next weekend?");
    // The one derived value.
    expect(lead.phoneE164).toBe("+17805550142");
    // Never geocoded synchronously; the backfill owns pins.
    expect(lead.geocodedAt).toBeNull();

    // The office hears about it on the feed.
    const feed = await db
      .select()
      .from(activityTable)
      .where(
        and(
          eq(activityTable.companyId, companyId),
          eq(activityTable.type, "lead_request_received"),
        ),
      );
    const entry = feed.find((f) => f.message.includes(`Form_${runId}`));
    expect(entry).toBeDefined();
    expect(entry!.message).toContain("Nadia");
  });

  it("submitting twice makes two leads — a re-submit is a person, not a duplicate", async () => {
    const body = {
      firstName: "Twice",
      lastName: `Form_${runId}`,
      phone: "780-555-0143",
      email: EMAIL("twice"),
    };
    expect((await submit(body)).status).toBe(201);
    expect((await submit(body)).status).toBe(201);
    expect(await ourLeads(EMAIL("twice"))).toHaveLength(2);
  });

  it("keeps an unusual phone format, storing it without a derived E.164", async () => {
    const res = await submit({
      phone: "call the front desk: 42",
      email: EMAIL("odd"),
    });
    expect(res.status).toBe(201);
    const [lead] = await ourLeads(EMAIL("odd"));
    expect(lead!.phoneNumber).toBe("call the front desk: 42");
    expect(lead!.phoneE164).toBeNull();
  });
});

describe("what gets turned away", () => {
  it("rejects a submission without a phone number and stores nothing", async () => {
    for (const body of [
      { email: EMAIL("nophone") },
      { phone: "", email: EMAIL("nophone") },
      { phone: "   ", email: EMAIL("nophone") },
    ]) {
      const res = await submit(body);
      expect(res.status).toBe(400);
    }
    expect(await ourLeads(EMAIL("nophone"))).toHaveLength(0);
  });

  it("swallows a honeypot submission: success on the wire, nothing stored", async () => {
    const res = await submit({
      phone: "780-555-0144",
      email: EMAIL("bot"),
      // Only a bot filling every field ever fills this one.
      website: "https://definitely-a-bot.example.com",
    });
    // A bot that gets an error learns which field to skip next time.
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(await ourLeads(EMAIL("bot"))).toHaveLength(0);
  });

  it("rejects a field over its size cap and stores nothing", async () => {
    const res = await submit({
      phone: "780-555-0145",
      email: EMAIL("big"),
      streetAddress: "x".repeat(5000),
    });
    expect(res.status).toBe(400);
    expect(await ourLeads(EMAIL("big"))).toHaveLength(0);
  });

  it("rate-limits one address without touching another", async () => {
    const hammer = `203.0.113.7`;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await submit(
        { phone: "780-555-0146", email: EMAIL("hammer") },
        { address: hammer },
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
    expect(statuses[5]).toBe(429);
    // The five that got in are stored; the hammered sixth is not.
    expect(await ourLeads(EMAIL("hammer"))).toHaveLength(5);

    // A different customer on a different address sails through.
    const other = await submit(
      { phone: "780-555-0147", email: EMAIL("neighbor") },
      { address: "203.0.113.8" },
    );
    expect(other.status).toBe(201);
  });

  it("buckets by the proxy-written last hop, not the client's claimed chain", async () => {
    // A bot inventing a fresh first-hop address on every request must stay
    // in one bucket: only the final entry is written by our own proxy.
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await submit(
        { phone: "780-555-0148", email: EMAIL("spoof") },
        { address: `198.51.100.${i}, 203.0.113.99` },
      );
      statuses.push(res.status);
    }
    expect(statuses[5]).toBe(429);
  });
});

describe("the inbox it lands in", () => {
  it("shows up alongside sheet leads and prefill reads it like any other", async () => {
    // The Leads API itself is authenticated dashboard territory — covered by
    // leads.test.ts. What matters here is that a form submission is an
    // ordinary row in the same table with the same shape the booking desk
    // prefills from, differing only in its source marker.
    await submit({
      firstName: "Inbox",
      lastName: `Form_${runId}`,
      phone: "780-555-0149",
      email: EMAIL("inbox"),
      service: "Move-in / move-out",
    });
    const [lead] = await ourLeads(EMAIL("inbox"));
    expect(lead!.companyId).toBe(companyId);
    expect(lead!.source).toBe("form");
    expect(lead!.service).toBe("Move-in / move-out");
    // Same status machine as sheet leads — convert/dismiss work unchanged.
    expect(lead!.status).toBe("new");
    expect(lead!.convertedBookingId).toBeNull();
  });
});

describe("owner notification on form submit", () => {
  it("sends a text through pending_texts with the customer name and E.164 phone", async () => {
    const res = await submit({
      firstName: "Notify",
      lastName: `Test_${runId}`,
      phone: "780-555-0190",
      email: EMAIL("notify"),
    });
    expect(res.status).toBe(201);

    // The route must hand the composed message to the real queue. The queue
    // claims the row and resolves `to: null` to the seeded notification number
    // before calling the Quo transport.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, input] = sendMessage.mock.calls[0]!;
    expect(input.to).toBe("+15559990000");
    expect(input.content).toContain("Notify");
    expect(input.content).toContain(`Test_${runId}`);
    // The E.164 form of 780-555-0190.
    expect(input.content).toContain("+17805550190");
    expect(
      await db
        .select()
        .from(pendingTextsTable)
        .where(eq(pendingTextsTable.companyId, companyId)),
    ).toHaveLength(0);
  });

  it("uses the raw phone in the text when E.164 normalization fails", async () => {
    const res = await submit({
      phone: "call the front desk: ext 7",
      email: EMAIL("notify-raw"),
    });
    expect(res.status).toBe(201);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, input] = sendMessage.mock.calls[0]!;
    expect(input.content).toContain("call the front desk: ext 7");
  });

  it("still returns 201 when queuing throws — the customer's submission is never affected", async () => {
    sendMessage.mockRejectedValueOnce(new Error("quo is down"));

    const res = await submit({
      phone: "780-555-0191",
      email: EMAIL("notify-fail"),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    // The lead row is committed even though the notify threw.
    expect(await ourLeads(EMAIL("notify-fail"))).toHaveLength(1);
    const pending = await db
      .select()
      .from(pendingTextsTable)
      .where(eq(pendingTextsTable.companyId, companyId));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.kind).toBe("form_lead_notify");
  });

  it("does not queue a text for honeypot submissions that are swallowed", async () => {
    const res = await submit({
      phone: "780-555-0192",
      email: EMAIL("notify-bot"),
      website: "https://bot.example.com",
    });
    expect(res.status).toBe(201);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
