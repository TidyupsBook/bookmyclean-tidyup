/**
 * Booking a Jobber-origin lead.
 *
 * A lead that arrived through Jobber's own form already has a client,
 * property and request over there. The booking the desk makes from it must
 * attach to those — born `jobberSynced`, wearing the ids — so the outbound
 * push refuses to mint a duplicate client or request. And if the request
 * pull had already imported the same request as an untouched pending
 * booking, that twin is cancelled and hands its request id to the booking
 * the desk actually made.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

const schedulePushMock = vi.fn(async () => undefined);
vi.mock("../services/jobberPush", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/jobberPush")>();
  return {
    ...actual,
    scheduleJobberPush: (...args: unknown[]) =>
      schedulePushMock(...(args as [])),
  };
});

import app from "../app";
import { jobberPushBlockedReason } from "../services/jobberPush";
import {
  db,
  pool,
  companiesTable,
  bookingsTable,
  bookingAssignmentsTable,
  activityTable,
  leadsTable,
  clientsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

const runId = `${Date.now()}_${process.pid}`;
const OWNER = `bjl_owner_${runId}`;

let server: http.Server;
let baseUrl: string;
let companyId: number;

async function createBooking(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": OWNER },
    body: JSON.stringify(body),
  });
}

async function insertJobberLead(n: number) {
  const [lead] = await db
    .insert(leadsTable)
    .values({
      companyId,
      source: "jobber",
      externalId: `bjl_request_${runId}_${n}`,
      sourceTab: "Jobber request",
      firstName: "Lena",
      lastName: `FromJobber${n}`,
      phoneNumber: `+1403555${String(3000 + n).slice(-4)}`,
      phoneE164: `+1403555${String(3000 + n).slice(-4)}`,
      service: "Move-in clean",
      jobberRequestId: `bjl_request_${runId}_${n}`,
      jobberClientId: `bjl_client_${runId}_${n}`,
      jobberPropertyId: `bjl_prop_${runId}_${n}`,
      jobberWebUri: `https://secure.getjobber.com/requests/bjl_${n}`,
    })
    .returning();
  return lead!;
}

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: OWNER,
      name: `Jobber Lead Booking Co ${runId}`,
      timezone: "America/Edmonton",
      jobberConnected: true,
      jobberAccessToken: "enc",
      jobberRefreshToken: "enc",
    })
    .returning();
  companyId = company!.id;

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  const bookings = await db
    .select({ id: bookingsTable.id })
    .from(bookingsTable)
    .where(eq(bookingsTable.companyId, companyId));
  for (const b of bookings) {
    await db
      .delete(bookingAssignmentsTable)
      .where(eq(bookingAssignmentsTable.bookingId, b.id));
  }
  await db.delete(activityTable).where(eq(activityTable.companyId, companyId));
  await db.delete(bookingsTable).where(eq(bookingsTable.companyId, companyId));
  await db.delete(leadsTable).where(eq(leadsTable.companyId, companyId));
  await db.delete(clientsTable).where(eq(clientsTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await pool.end();
});

describe("POST /api/bookings from a Jobber-origin lead", () => {
  it("attaches to Jobber's existing client and request, and never pushes back", async () => {
    const lead = await insertJobberLead(1);
    schedulePushMock.mockClear();

    const res = await createBooking({
      leadId: lead.id,
      customerName: "Lena FromJobber1",
      customerPhone: lead.phoneNumber,
      service: "Move-in clean",
      scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: number };

    const [booking] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, created.id));
    expect(booking!.leadId).toBe(lead.id);
    // Born synced, wearing Jobber's own ids.
    expect(booking!.jobberSynced).toBe(true);
    expect(booking!.jobberSyncedRequestId).toBe(lead.jobberRequestId);
    expect(booking!.jobberClientId).toBe(lead.jobberClientId);
    expect(booking!.jobberPropertyId).toBe(lead.jobberPropertyId);
    expect(booking!.jobberWebUri).toBe(lead.jobberWebUri);

    // No automatic push was even scheduled...
    expect(schedulePushMock).not.toHaveBeenCalled();
    // ...and the push gate itself refuses this booking, same as any other
    // row that came from Jobber.
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    expect(jobberPushBlockedReason(company!, booking!)).toMatch(
      /came from Jobber/,
    );
  });

  it("cancels an untouched pending twin and takes over its request id", async () => {
    const lead = await insertJobberLead(2);
    // The request pull imported the same enquiry as a pending booking
    // before (or while) it became a lead.
    const [twin] = await db
      .insert(bookingsTable)
      .values({
        companyId,
        callId: null,
        customerName: "Lena FromJobber2",
        customerPhone: lead.phoneNumber ?? "",
        service: "Jobber request",
        scheduledFor: new Date(),
        status: "pending",
        jobberSynced: true,
        jobberSyncedRequestId: lead.jobberRequestId,
      })
      .returning();

    const res = await createBooking({
      leadId: lead.id,
      customerName: "Lena FromJobber2",
      customerPhone: lead.phoneNumber,
      service: "Move-in clean",
      scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: number };

    const [twinAfter] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, twin!.id));
    expect(twinAfter!.status).toBe("canceled");
    expect(twinAfter!.jobberSyncedRequestId).toBeNull();

    const [booking] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, created.id));
    expect(booking!.jobberSyncedRequestId).toBe(lead.jobberRequestId);
    expect(booking!.jobberSynced).toBe(true);
  });

  it("leaves a twin the office already touched alone", async () => {
    const lead = await insertJobberLead(3);
    const [twin] = await db
      .insert(bookingsTable)
      .values({
        companyId,
        callId: null,
        customerName: "Lena FromJobber3",
        customerPhone: lead.phoneNumber ?? "",
        service: "Jobber request",
        scheduledFor: new Date(),
        status: "confirmed",
        jobberSynced: true,
        jobberSyncedRequestId: lead.jobberRequestId,
      })
      .returning();

    const res = await createBooking({
      leadId: lead.id,
      customerName: "Lena FromJobber3",
      customerPhone: lead.phoneNumber,
      service: "Move-in clean",
      scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: number };

    const [twinAfter] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, twin!.id));
    expect(twinAfter!.status).toBe("confirmed");
    expect(twinAfter!.jobberSyncedRequestId).toBe(lead.jobberRequestId);

    // The new booking still carries the client/property (no duplicate client
    // can be minted) but leaves the unique request id with the office's row.
    const [booking] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, created.id));
    expect(booking!.jobberSyncedRequestId).toBeNull();
    expect(booking!.jobberSynced).toBe(true);
    expect(booking!.jobberClientId).toBe(lead.jobberClientId);
  });
});
