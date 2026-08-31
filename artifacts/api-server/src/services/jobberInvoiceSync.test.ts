/**
 * Jobber invoice pull tests.
 *
 * The Jobber API is stubbed; what's proved here is the mirror's honesty:
 * re-pulls update in place instead of duplicating, money survives the
 * float-dollars → integer-cents crossing (total AND the outstanding
 * balance), the watermark only asks for what's new and holds on a capped
 * pull, and invoiced customers land in the client directory.
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
  clientsTable,
  jobberInvoicesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  syncCompanyJobberInvoices,
  type JobberInvoiceNode,
} from "./jobberInvoiceSync";

const runId = `${Date.now()}_${process.pid}`;
let companyId: number;

function invoice(
  n: number,
  over: Partial<JobberInvoiceNode> = {},
): JobberInvoiceNode {
  return {
    id: `invoice_${runId}_${n}`,
    invoiceNumber: `${2000 + n}`,
    subject: "Move-out clean",
    invoiceStatus: "awaiting_payment",
    createdAt: new Date(Date.now() - n * 3600_000).toISOString(),
    updatedAt: new Date(Date.now() - n * 60_000).toISOString(),
    issuedDate: new Date(Date.now() - n * 1800_000).toISOString(),
    dueDate: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
    jobberWebUri: `https://secure.getjobber.com/invoices/${n}`,
    amounts: { total: 189.99, invoiceBalance: 189.99 },
    client: {
      id: `inv_client_${runId}_${n}`,
      // Distinct phones per client — the directory (correctly) merges two
      // sightings of one number into one row.
      firstName: "Ida",
      lastName: `Voice${n}`,
      phone: `+155500097${70 + n}`,
    },
    properties: {
      nodes: [
        {
          address: {
            street: "34 Elm St",
            city: "Calgary",
            province: "AB",
            postalCode: "T2P 2K8",
          },
        },
      ],
    },
    ...over,
  };
}

function respondWith(invoices: JobberInvoiceNode[]): void {
  graphqlMock.mockReset();
  graphqlMock.mockResolvedValue({
    invoices: {
      nodes: invoices,
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });
}

async function stored() {
  return db
    .select()
    .from(jobberInvoicesTable)
    .where(eq(jobberInvoicesTable.companyId, companyId));
}

async function freshCompany() {
  const [company] = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId));
  return company!;
}

beforeAll(async () => {
  const [row] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `jis_owner_${runId}`,
      name: `Invoice Sync Co ${runId}`,
      timezone: "America/Edmonton",
      jobberConnected: true,
      jobberAccessToken: "enc",
      jobberRefreshToken: "enc",
    })
    .returning();
  companyId = row!.id;
});

afterAll(async () => {
  await db
    .delete(jobberInvoicesTable)
    .where(eq(jobberInvoicesTable.companyId, companyId));
  await db.delete(clientsTable).where(eq(clientsTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end();
});

describe("syncCompanyJobberInvoices", () => {
  it("imports invoices with money as integer cents, balance included", async () => {
    respondWith([
      invoice(1),
      invoice(2, {
        invoiceStatus: "paid",
        amounts: { total: 250, invoiceBalance: 0 },
      }),
      invoice(3, { invoiceStatus: "draft", amounts: null }),
    ]);
    const result = await syncCompanyJobberInvoices(await freshCompany());
    expect(result.imported).toBe(3);
    expect(result.complete).toBe(true);

    const all = await stored();
    expect(all).toHaveLength(3);
    const i1 = all.find((i) => i.jobberInvoiceId === `invoice_${runId}_1`)!;
    expect(i1.totalCents).toBe(18999);
    expect(i1.balanceCents).toBe(18999);
    expect(i1.status).toBe("awaiting_payment");
    expect(i1.clientName).toBe("Ida Voice1");
    expect(i1.invoiceNumber).toBe("2001");
    expect(i1.propertyAddress).toBe("34 Elm St, Calgary, AB T2P 2K8");
    const i2 = all.find((i) => i.jobberInvoiceId === `invoice_${runId}_2`)!;
    expect(i2.status).toBe("paid");
    expect(i2.totalCents).toBe(25000);
    expect(i2.balanceCents).toBe(0);
    const i3 = all.find((i) => i.jobberInvoiceId === `invoice_${runId}_3`)!;
    expect(i3.totalCents).toBeNull();
    expect(i3.balanceCents).toBeNull();
  });

  it("puts every invoiced customer in the client directory", async () => {
    const clients = await db
      .select()
      .from(clientsTable)
      .where(eq(clientsTable.companyId, companyId));
    const names = clients.map((c) => c.name).sort();
    expect(names).toEqual(["Ida Voice1", "Ida Voice2", "Ida Voice3"]);
    expect(clients.every((c) => c.source === "jobber")).toBe(true);
  });

  it("a payment landing in Jobber updates the row in place, never duplicates", async () => {
    respondWith([
      invoice(1, {
        invoiceStatus: "paid",
        amounts: { total: 189.99, invoiceBalance: 0 },
      }),
    ]);
    const result = await syncCompanyJobberInvoices(await freshCompany());
    expect(result.updated).toBe(1);
    expect(result.imported).toBe(0);

    const all = await stored();
    expect(all).toHaveLength(3);
    const i1 = all.find((i) => i.jobberInvoiceId === `invoice_${runId}_1`)!;
    expect(i1.status).toBe("paid");
    expect(i1.balanceCents).toBe(0);
  });

  it("asks Jobber only for what changed since the watermark", async () => {
    respondWith([]);
    await syncCompanyJobberInvoices(await freshCompany());
    const [, , variables] = graphqlMock.mock.calls[0] as [
      string,
      string,
      { filter: { updatedAt: { after: string } } },
    ];
    const after = new Date(variables.filter.updatedAt.after).getTime();
    // Watermark = the completed backfill's start minus its hour of slack,
    // minus the overlap — a couple of hours at most, not the year-long
    // first pull.
    expect(Date.now() - after).toBeLessThan(2 * 60 * 60 * 1000);
  });

  it("a capped pull holds the watermark for the next run", async () => {
    const [before] = await db
      .select({ cursor: companiesTable.jobberInvoicesSyncedThrough })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    // Complete pulls above must have advanced the cursor.
    expect(before!.cursor).not.toBeNull();

    // Jobber claims there is always another page: the run hits its page cap.
    // Pages arrive in CREATED_AT order, so rows already written say nothing
    // about updates on the pages never seen. The cursor must not move.
    graphqlMock.mockReset();
    graphqlMock.mockResolvedValue({
      invoices: {
        nodes: [invoice(50)],
        pageInfo: { hasNextPage: true, endCursor: "cap" },
      },
    });
    const result = await syncCompanyJobberInvoices(await freshCompany());
    expect(result.complete).toBe(false);
    expect(graphqlMock).toHaveBeenCalledTimes(40);

    const [after] = await db
      .select({ cursor: companiesTable.jobberInvoicesSyncedThrough })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    expect(after!.cursor!.getTime()).toBe(before!.cursor!.getTime());
  });

  it("a capped first pull resumes where it left off instead of re-reading page one", async () => {
    // Fresh company: no watermark yet, so the sync is in backfill mode.
    const [row] = await db
      .insert(companiesTable)
      .values({
        ownerUserId: `jis_backfill_owner_${runId}`,
        name: `Invoice Backfill Co ${runId}`,
        timezone: "America/Edmonton",
        jobberConnected: true,
        jobberAccessToken: "enc",
        jobberRefreshToken: "enc",
      })
      .returning();
    const bfCompanyId = row!.id;
    const bfCompany = async () => {
      const [c] = await db
        .select()
        .from(companiesTable)
        .where(eq(companiesTable.id, bfCompanyId));
      return c!;
    };

    try {
      // Run 1: Jobber always claims another page — the run caps out. The
      // last node it mirrored carries the newest createdAt seen so far.
      const newestCreated = new Date(Date.now() - 30 * 24 * 3600_000);
      graphqlMock.mockReset();
      graphqlMock.mockResolvedValue({
        invoices: {
          nodes: [
            {
              ...invoice(90),
              id: `invoice_${runId}_bf_prefix`,
              createdAt: newestCreated.toISOString(),
            },
          ],
          pageInfo: { hasNextPage: true, endCursor: "cap" },
        },
      });
      const capped = await syncCompanyJobberInvoices(await bfCompany());
      expect(capped.complete).toBe(false);
      // Watermark still unset: the backfill is not done.
      expect((await bfCompany()).jobberInvoicesSyncedThrough).toBeNull();

      // Run 2 must ask for invoices created after the mirrored prefix — not
      // repeat the year-long window whose first pages it already has.
      graphqlMock.mockReset();
      graphqlMock.mockResolvedValue({
        invoices: {
          nodes: [{ ...invoice(91), id: `invoice_${runId}_bf_page41` }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
      const resumed = await syncCompanyJobberInvoices(await bfCompany());
      expect(resumed.complete).toBe(true);
      const [, , variables] = graphqlMock.mock.calls[0] as [
        string,
        string,
        { filter: { createdAt: { after: string } } },
      ];
      expect(new Date(variables.filter.createdAt.after).getTime()).toBe(
        newestCreated.getTime(),
      );
      // The "page 41" invoice landed, and the finished backfill set the
      // watermark so the next run switches to incremental mode.
      const stored41 = await db
        .select()
        .from(jobberInvoicesTable)
        .where(
          eq(jobberInvoicesTable.jobberInvoiceId, `invoice_${runId}_bf_page41`),
        );
      expect(stored41).toHaveLength(1);
      expect((await bfCompany()).jobberInvoicesSyncedThrough).not.toBeNull();
    } finally {
      await db
        .delete(jobberInvoicesTable)
        .where(eq(jobberInvoicesTable.companyId, bfCompanyId));
      await db
        .delete(clientsTable)
        .where(eq(clientsTable.companyId, bfCompanyId));
      await db.delete(companiesTable).where(eq(companiesTable.id, bfCompanyId));
    }
  });

  it("does nothing for a company that isn't connected", async () => {
    graphqlMock.mockReset();
    const company = await freshCompany();
    const result = await syncCompanyJobberInvoices({
      ...company,
      jobberConnected: false,
    });
    expect(result.imported + result.updated).toBe(0);
    expect(graphqlMock).not.toHaveBeenCalled();
  });
});
