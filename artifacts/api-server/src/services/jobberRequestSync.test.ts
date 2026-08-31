/**
 * Jobber request pull tests.
 *
 * The Jobber API is stubbed; what's proved is the direction discipline: an
 * open Jobber request becomes exactly one pending booking, a request the app
 * itself pushed is adopted rather than duplicated, a closed request cancels a
 * booking the office never touched — and never one they accepted — and the
 * watermark only advances on a complete pull.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

const graphqlMock = vi.fn();
vi.mock("../lib/jobber", () => ({
  getValidAccessToken: vi.fn(async () => "test-token"),
  jobberGraphql: (...args: unknown[]) => graphqlMock(...args),
}));

import {
  db,
  pool,
  companiesTable,
  bookingsTable,
  clientsTable,
  leadsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  syncCompanyJobberRequests,
  type JobberRequestNode,
} from "./jobberRequestSync";

const runId = `${Date.now()}_${process.pid}`;
let companyId: number;

function request(
  n: number,
  over: Partial<JobberRequestNode> = {},
): JobberRequestNode {
  return {
    id: `request_${runId}_${n}`,
    title: "Deep clean estimate",
    requestStatus: "new",
    createdAt: new Date(Date.now() - n * 3600_000).toISOString(),
    updatedAt: new Date(Date.now() - n * 60_000).toISOString(),
    jobberWebUri: `https://secure.getjobber.com/requests/${n}`,
    contactName: null,
    phone: null,
    email: `req${n}_${runId}@example.com`,
    client: {
      id: `reqclient_${runId}_${n}`,
      firstName: "Rae",
      lastName: `Quest${n}`,
      phone: `+155500071${10 + n}`,
    },
    property: {
      id: `prop_${runId}_${n}`,
      address: {
        street: `${n} Request Ave`,
        city: "Calgary",
        province: "AB",
        postalCode: "T2P 1J9",
      },
    },
    ...over,
  };
}

function respondWith(nodes: JobberRequestNode[]): void {
  graphqlMock.mockReset();
  graphqlMock.mockResolvedValue({
    requests: {
      nodes,
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });
}

async function company() {
  const [row] = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId));
  return row!;
}

async function bookingFor(requestId: string) {
  const [row] = await db
    .select()
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.companyId, companyId),
        eq(bookingsTable.jobberSyncedRequestId, requestId),
      ),
    );
  return row;
}

beforeAll(async () => {
  const [row] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `jrs_owner_${runId}`,
      name: `Request Sync Co ${runId}`,
      timezone: "America/Edmonton",
      jobberConnected: true,
      jobberAccessToken: "enc",
      jobberRefreshToken: "enc",
    })
    .returning();
  companyId = row!.id;
});

afterAll(async () => {
  await db.delete(bookingsTable).where(eq(bookingsTable.companyId, companyId));
  await db.delete(leadsTable).where(eq(leadsTable.companyId, companyId));
  await db.delete(clientsTable).where(eq(clientsTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end();
});

describe("syncCompanyJobberRequests", () => {
  it("imports an open request as a pending booking with customer and links", async () => {
    respondWith([request(1)]);
    const result = await syncCompanyJobberRequests(await company());
    expect(result.imported).toBe(1);
    expect(result.complete).toBe(true);

    const b = (await bookingFor(`request_${runId}_1`))!;
    expect(b.status).toBe("pending");
    expect(b.customerName).toBe("Rae Quest1");
    expect(b.customerPhone).toBe("+1555000711" + "1");
    expect(b.customerAddress).toBe("1 Request Ave");
    expect(b.addressCity).toBe("Calgary");
    expect(b.service).toBe("Deep clean estimate");
    expect(b.jobberClientId).toBe(`reqclient_${runId}_1`);
    expect(b.jobberPropertyId).toBe(`prop_${runId}_1`);
    expect(b.jobberWebUri).toBe("https://secure.getjobber.com/requests/1");
    // Marked synced so the outbound push never mints a duplicate request…
    expect(b.jobberSynced).toBe(true);
    // …but never wearing the columns that would expose it to the calendar
    // sweep or the outbound push's own id column.
    expect(b.jobberJobId).toBeNull();
    expect(b.jobberVisitId).toBeNull();
    expect(b.jobberSyncedJobId).toBeNull();
    // Visible on the Bookings list: at/above the history floor, not months ago.
    expect(b.scheduledFor.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("re-pulling updates the pending booking in place, never duplicates", async () => {
    respondWith([
      request(1, { title: "Deep clean + windows", requestStatus: "overdue" }),
    ]);
    const result = await syncCompanyJobberRequests(await company());
    expect(result.imported).toBe(0);
    expect(result.updated).toBe(1);

    const rows = await db
      .select()
      .from(bookingsTable)
      .where(
        and(
          eq(bookingsTable.companyId, companyId),
          eq(bookingsTable.jobberSyncedRequestId, `request_${runId}_1`),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.service).toBe("Deep clean + windows");
  });

  it("adopts a request the app itself pushed instead of importing a copy", async () => {
    const pushedRequestId = `request_${runId}_pushed`;
    await db.insert(bookingsTable).values({
      companyId,
      customerName: "Pushed By App",
      customerPhone: "+15550009999",
      service: "Move-out clean",
      scheduledFor: new Date(),
      status: "pending",
      jobberSynced: true,
      jobberJobId: pushedRequestId,
    });

    respondWith([request(2, { id: pushedRequestId })]);
    const result = await syncCompanyJobberRequests(await company());
    expect(result.adopted).toBe(1);
    expect(result.imported).toBe(0);

    const rows = await db
      .select()
      .from(bookingsTable)
      .where(
        and(
          eq(bookingsTable.companyId, companyId),
          eq(bookingsTable.jobberJobId, pushedRequestId),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.jobberSyncedRequestId).toBe(pushedRequestId);
    // The app's own booking keeps its own details.
    expect(rows[0]!.customerName).toBe("Pushed By App");
  });

  it("skips a request a lead's own push created, instead of importing a copy", async () => {
    // A website-form lead pushes itself to Jobber on submit. Until the lead
    // is converted there is no booking carrying that request id, so without
    // this skip the pull would re-import the same enquiry as a pending
    // booking — one enquiry on the office's plate twice.
    const leadRequestId = `request_${runId}_lead`;
    await db.insert(leadsTable).values({
      companyId,
      source: "form",
      externalId: `jrs_lead_${runId}`,
      sourceTab: "Website request form",
      firstName: "Form",
      lastName: "Lead",
      phoneNumber: "+15550008888",
      jobberSynced: true,
      jobberRequestId: leadRequestId,
    });

    respondWith([request(9, { id: leadRequestId })]);
    const result = await syncCompanyJobberRequests(await company());
    expect(result.imported).toBe(0);
    expect(result.adopted).toBe(0);

    const rows = await db
      .select()
      .from(bookingsTable)
      .where(
        and(
          eq(bookingsTable.companyId, companyId),
          eq(bookingsTable.jobberSyncedRequestId, leadRequestId),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it("a closed request cancels a booking the office never accepted", async () => {
    respondWith([request(1, { requestStatus: "converted" })]);
    const result = await syncCompanyJobberRequests(await company());
    expect(result.canceled).toBe(1);
    const b = (await bookingFor(`request_${runId}_1`))!;
    expect(b.status).toBe("canceled");
  });

  it("never touches a booking the office accepted", async () => {
    respondWith([request(3)]);
    await syncCompanyJobberRequests(await company());
    const imported = (await bookingFor(`request_${runId}_3`))!;
    await db
      .update(bookingsTable)
      .set({ status: "confirmed", clientApprovedAt: new Date() })
      .where(eq(bookingsTable.id, imported.id));

    respondWith([request(3, { requestStatus: "archived" })]);
    const result = await syncCompanyJobberRequests(await company());
    expect(result.canceled).toBe(0);
    const after = (await bookingFor(`request_${runId}_3`))!;
    expect(after.status).toBe("confirmed");
  });

  it("never doubles a request that is already in the Leads inbox", async () => {
    // The webhook (or its sweep) already made this enquiry a lead — leads
    // win for brand-new Jobber-form requests, whatever the lead's status:
    // a dismissed enquiry must not resurface as a pending booking.
    const node = request(60);
    await db.insert(leadsTable).values({
      companyId,
      source: "jobber",
      externalId: node.id,
      sourceTab: "Jobber request",
      firstName: "Rae",
      jobberRequestId: node.id,
      status: "dismissed",
    });
    respondWith([node]);
    const result = await syncCompanyJobberRequests(await company());
    expect(result.imported).toBe(0);
    expect(await bookingFor(node.id)).toBeUndefined();
  });

  it("skips closed requests it never imported", async () => {
    respondWith([request(4, { requestStatus: "archived" })]);
    const result = await syncCompanyJobberRequests(await company());
    expect(result.imported + result.updated + result.canceled).toBe(0);
    expect(await bookingFor(`request_${runId}_4`)).toBeUndefined();
  });

  it("puts every requester in the client directory", async () => {
    const clients = await db
      .select()
      .from(clientsTable)
      .where(eq(clientsTable.companyId, companyId));
    const names = clients.map((c) => c.name);
    expect(names).toContain("Rae Quest1");
    expect(clients.every((c) => c.source === "jobber")).toBe(true);
  });

  it("a capped pull holds the watermark for the next run", async () => {
    const before = (await company()).jobberRequestsSyncedThrough;
    expect(before).not.toBeNull();

    graphqlMock.mockReset();
    graphqlMock.mockResolvedValue({
      requests: {
        nodes: [request(50)],
        pageInfo: { hasNextPage: true, endCursor: "cap" },
      },
    });
    const result = await syncCompanyJobberRequests(await company());
    expect(result.complete).toBe(false);
    expect(graphqlMock).toHaveBeenCalledTimes(40);

    const after = (await company()).jobberRequestsSyncedThrough;
    expect(after!.getTime()).toBe(before!.getTime());
  });

  it("does nothing for a company that isn't connected", async () => {
    graphqlMock.mockReset();
    const result = await syncCompanyJobberRequests({
      ...(await company()),
      jobberConnected: false,
    });
    expect(result.imported + result.updated).toBe(0);
    expect(graphqlMock).not.toHaveBeenCalled();
  });
});
