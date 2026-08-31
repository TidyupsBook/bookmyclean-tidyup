/**
 * Jobber lead import + sweep tests.
 *
 * The sweep is the webhook's safety net: a request whose delivery never
 * arrived must still turn up as a lead, and one the webhook already handled
 * must not be doubled. The pre-checks are pinned too — the sweep must not
 * spend shared Jobber rate budget fetching details for requests that are
 * already leads or bookings.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

const pageMock = vi.fn();
const detailMock = vi.fn();
vi.mock("../lib/jobber", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/jobber")>();
  return {
    ...actual,
    getValidAccessToken: vi.fn(async () => "test-token"),
    jobberGraphql: (...args: unknown[]) => pageMock(...args),
    fetchJobberRequestDetails: (...args: unknown[]) => detailMock(...args),
  };
});

import {
  db,
  pool,
  companiesTable,
  bookingsTable,
  leadsTable,
  activityTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  importJobberRequestLead,
  sweepJobberRequestLeads,
  JOBBER_LEAD_SOURCE_TAB,
} from "./jobberRequestLeads";
import type { JobberRequestDetails } from "../lib/jobber";

const runId = `${Date.now()}_${process.pid}`;
let companyId: number;

function detail(
  n: number,
  over: Partial<JobberRequestDetails> = {},
): JobberRequestDetails {
  return {
    id: `jrl_request_${runId}_${n}`,
    title: "Weekly clean",
    requestStatus: "new",
    createdAt: new Date(Date.now() - n * 60_000).toISOString(),
    jobberWebUri: `https://secure.getjobber.com/requests/jrl_${n}`,
    contactName: "Casey Contact",
    phone: `+1587555${String(2000 + n).slice(-4)}`,
    email: null,
    client: null,
    property: null,
    notes: { nodes: [] },
    ...over,
  };
}

async function company() {
  const [row] = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId));
  return row!;
}

async function leadsFor(requestId: string) {
  return db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.companyId, companyId),
        eq(leadsTable.externalId, requestId),
      ),
    );
}

beforeAll(async () => {
  const [row] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `jrl_owner_${runId}`,
      name: `Jobber Lead Sweep Co ${runId}`,
      timezone: "America/Edmonton",
      jobberConnected: true,
      jobberAccountId: `jrl_acct_${runId}`,
      jobberAccessToken: "enc",
      jobberRefreshToken: "enc",
    })
    .returning();
  companyId = row!.id;
});

afterAll(async () => {
  await db.delete(activityTable).where(eq(activityTable.companyId, companyId));
  await db.delete(leadsTable).where(eq(leadsTable.companyId, companyId));
  await db.delete(bookingsTable).where(eq(bookingsTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end();
});

beforeEach(() => {
  pageMock.mockReset();
  detailMock.mockReset();
});

describe("importJobberRequestLead", () => {
  it("stores the request verbatim, falling back to the contact name", async () => {
    const d = detail(1);
    expect(await importJobberRequestLead(await company(), d)).toBe("imported");
    const [lead] = await leadsFor(d.id);
    expect(lead!.sourceTab).toBe(JOBBER_LEAD_SOURCE_TAB);
    expect(lead!.firstName).toBe("Casey Contact");
    expect(lead!.lastName).toBeNull();
    expect(lead!.phoneNumber).toBe(d.phone);
    expect(lead!.service).toBe("Weekly clean");
  });

  it("is idempotent: the second import of the same request is a duplicate", async () => {
    const d = detail(2);
    expect(await importJobberRequestLead(await company(), d)).toBe("imported");
    expect(await importJobberRequestLead(await company(), d)).toBe("duplicate");
    expect(await leadsFor(d.id)).toHaveLength(1);
  });

  it("skips a request that is no longer open", async () => {
    const d = detail(3, { requestStatus: "archived" });
    expect(await importJobberRequestLead(await company(), d)).toBe(
      "skipped_closed",
    );
    expect(await leadsFor(d.id)).toHaveLength(0);
  });

  it("skips a request this app already has as a booking", async () => {
    const d = detail(4);
    await db.insert(bookingsTable).values({
      companyId,
      callId: null,
      customerName: "Already Ours",
      customerPhone: "+15875550004",
      service: "Deep clean",
      scheduledFor: new Date(),
      status: "pending",
      jobberSynced: true,
      jobberJobId: d.id,
    });
    expect(await importJobberRequestLead(await company(), d)).toBe(
      "skipped_ours",
    );
    expect(await leadsFor(d.id)).toHaveLength(0);
  });

  it("skips a request the outbound lead push created — no boomerang echo", async () => {
    // A website-form lead pushes itself to Jobber, and Jobber's
    // REQUEST_CREATE webhook fires for that request like any other. Once the
    // push has written its request id onto the form lead, the import must
    // recognise the request as our own — otherwise every website enquiry
    // arrives in the inbox twice.
    const d = detail(5);
    await db.insert(leadsTable).values({
      companyId,
      source: "form",
      externalId: `jrl_form_lead_${runId}`,
      sourceTab: "Website request form",
      firstName: "Fern",
      lastName: "Site",
      phoneNumber: "+15875550005",
      jobberSynced: true,
      jobberRequestId: d.id,
    });
    expect(await importJobberRequestLead(await company(), d)).toBe(
      "skipped_ours",
    );
    expect(await leadsFor(d.id)).toHaveLength(0);
  });
});

describe("sweepJobberRequestLeads", () => {
  it("imports only what the webhook missed, without re-fetching handled requests", async () => {
    const handled = detail(10);
    const missed = detail(11);
    const closed = detail(12, { requestStatus: "converted" });
    const booked = detail(13);

    // The webhook already handled one...
    expect(await importJobberRequestLead(await company(), handled)).toBe(
      "imported",
    );
    // ...and one is already a booking (imported or pushed).
    await db.insert(bookingsTable).values({
      companyId,
      callId: null,
      customerName: "Booked Customer",
      customerPhone: "+15875550013",
      service: "Jobber request",
      scheduledFor: new Date(),
      status: "pending",
      jobberSynced: true,
      jobberSyncedRequestId: booked.id,
    });

    pageMock.mockResolvedValue({
      requests: {
        nodes: [
          { id: handled.id, requestStatus: "new" },
          { id: missed.id, requestStatus: "new" },
          { id: closed.id, requestStatus: "converted" },
          { id: booked.id, requestStatus: "new" },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    detailMock.mockResolvedValue(missed);

    const result = await sweepJobberRequestLeads(await company());
    expect(result.imported).toBe(1);

    // Rate budget: the detail read happened only for the genuinely missed one.
    expect(detailMock).toHaveBeenCalledTimes(1);
    expect(detailMock).toHaveBeenCalledWith("test-token", missed.id);

    expect(await leadsFor(handled.id)).toHaveLength(1);
    expect(await leadsFor(missed.id)).toHaveLength(1);
    expect(await leadsFor(closed.id)).toHaveLength(0);
    expect(await leadsFor(booked.id)).toHaveLength(0);
  });

  it("finds a just-missed request even when the window holds more than the page cap", async () => {
    // A busy account: 70 open requests in the 24h window, all but the very
    // newest already handled. The sweep reads newest-first, so the missed
    // one is on page one — the page cap bounds work without starving it.
    const total = 70;
    const ids = Array.from(
      { length: total },
      (_, i) => `jrl_busy_${runId}_${i}`,
    );
    const newestMissed = ids[0]!;
    await db.insert(leadsTable).values(
      ids.slice(1).map((id) => ({
        companyId,
        source: "jobber",
        externalId: id,
        sourceTab: JOBBER_LEAD_SOURCE_TAB,
        jobberRequestId: id,
      })),
    );

    const pageSize = 20;
    pageMock.mockImplementation((_token, query, variables) => {
      // The query itself must ask Jobber for newest-first — oldest-first
      // plus a page cap is exactly the starvation this test pins.
      expect(String(query)).toContain("DESCENDING");
      const { after } = variables as { after: string | null };
      const start = after ? Number(after) : 0;
      const nodes = ids
        .slice(start, start + pageSize)
        .map((id) => ({ id, requestStatus: "new" }));
      return Promise.resolve({
        requests: {
          nodes,
          pageInfo: {
            hasNextPage: start + pageSize < total,
            endCursor: String(start + pageSize),
          },
        },
      });
    });
    detailMock.mockImplementation((_token: string, id: string) =>
      Promise.resolve(detail(0, { id })),
    );

    const result = await sweepJobberRequestLeads(await company());
    expect(result.imported).toBe(1);
    expect(await leadsFor(newestMissed)).toHaveLength(1);
    // Bounded: three pages of ids, and one detail read for the one miss.
    expect(pageMock).toHaveBeenCalledTimes(3);
    expect(detailMock).toHaveBeenCalledTimes(1);
    expect(detailMock).toHaveBeenCalledWith("test-token", newestMissed);
  });

  it("does nothing for a company that isn't connected to Jobber", async () => {
    const [detached] = await db
      .insert(companiesTable)
      .values({
        ownerUserId: `jrl_detached_${runId}`,
        name: `No Jobber Co ${runId}`,
        timezone: "America/Edmonton",
      })
      .returning();
    try {
      const result = await sweepJobberRequestLeads(detached!);
      expect(result).toEqual({ imported: 0, checked: 0 });
      expect(pageMock).not.toHaveBeenCalled();
    } finally {
      await db
        .delete(companiesTable)
        .where(eq(companiesTable.id, detached!.id));
    }
  });
});
