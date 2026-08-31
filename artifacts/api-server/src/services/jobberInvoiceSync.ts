/**
 * Pulls invoices created in Jobber into the local `jobber_invoices` mirror,
 * so the dashboard can show who has paid and who still owes without opening
 * Jobber.
 *
 * Read-only and incremental, the same contract as the quote pull next door:
 * rows are keyed by (company, jobberInvoiceId) and re-pulls update in place.
 * The watermark is `jobberInvoicesSyncedThrough` on the company row — each
 * run asks Jobber only for invoices updated since then (minus a small
 * overlap for clock skew), so steady state costs one small page per cycle
 * out of the shared Jobber rate budget. The first pull reaches back a year.
 *
 * The watermark only advances when a run read every page Jobber offered,
 * and it is stored separately from the mirrored rows on purpose: a capped
 * run also writes rows, and pages arrive in CREATED_AT order (Jobber has no
 * updated-at sort guarantee across pages), so a row-derived watermark could
 * jump past updates on the pages a capped run never saw.
 *
 * Unlike quotes, an invoice never becomes a booking: the work already
 * happened. The mirror is purely "has this been paid?" — payment itself
 * stays in Jobber, reached through the deep link.
 */
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  db,
  companiesTable,
  jobberInvoicesTable,
  type Company,
} from "@workspace/db";
import { getValidAccessToken, jobberGraphql } from "../lib/jobber";
import { JOBBER_HISTORY_FLOOR } from "../lib/jobberHistory";
import { recordClientContact } from "./clientDirectory";
import { logger } from "../lib/logger";
const PAGE_SIZE = 25;
const MAX_PAGES = 40;
/** Re-read this much behind the watermark, against clock skew mid-write. */
const OVERLAP_MS = 10 * 60 * 1000;
/**
 * When the initial backfill finishes, the watermark is set this far behind
 * the finishing run's start. The backfill can span several capped runs, and
 * rows mirrored by an early run could be updated (a payment landing) before
 * the last run completes — this slack re-reads that whole stretch once.
 */
const BACKFILL_SLACK_MS = 60 * 60 * 1000;

export type JobberInvoiceNode = {
  id: string;
  /** Jobber's invoice number is a string in their API. */
  invoiceNumber: string | null;
  subject: string | null;
  invoiceStatus: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  issuedDate: string | null;
  dueDate: string | null;
  jobberWebUri: string | null;
  amounts: {
    total: number | null;
    invoiceBalance?: number | null;
  } | null;
  client: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
  } | null;
  /** Invoices can span properties; the first is the one shown on the card. */
  properties: {
    nodes: Array<{
      address: {
        street: string | null;
        city: string | null;
        province: string | null;
        postalCode: string | null;
      } | null;
    }>;
  } | null;
};

type InvoicesPage = {
  invoices: {
    nodes: JobberInvoiceNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  } | null;
};

const INVOICES_QUERY = `
  query SyncJobberInvoices($filter: InvoiceFilterAttributes, $first: Int!, $after: String) {
    invoices(filter: $filter, first: $first, after: $after, sort: [{ key: CREATED_AT, direction: ASCENDING }]) {
      nodes {
        id
        invoiceNumber
        subject
        invoiceStatus
        createdAt
        updatedAt
        issuedDate
        dueDate
        jobberWebUri
        amounts { total invoiceBalance }
        client { id firstName lastName phone }
        properties(first: 1) { nodes { address { street city province postalCode } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export type InvoiceSyncResult = {
  imported: number;
  updated: number;
  jobberCount: number;
  complete: boolean;
};

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Jobber returns float dollars; the database stores integer cents. */
function toCents(amount: number | null | undefined): number | null {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

function invoiceClientName(node: JobberInvoiceNode): string | null {
  const name = [node.client?.firstName ?? "", node.client?.lastName ?? ""]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
  return name || null;
}

function invoicePropertyAddress(node: JobberInvoiceNode): string | null {
  const a = node.properties?.nodes?.[0]?.address;
  if (!a) return null;
  const line = [a.street, a.city, a.province].filter(Boolean).join(", ");
  const full = [line, a.postalCode].filter(Boolean).join(" ").trim();
  return full || null;
}

/** One invoice sync per company at a time; a slow pull must not stack. */
const inFlight = new Set<number>();

export async function syncCompanyJobberInvoices(
  company: Company,
): Promise<InvoiceSyncResult> {
  const empty: InvoiceSyncResult = {
    imported: 0,
    updated: 0,
    jobberCount: 0,
    complete: true,
  };
  if (!company.jobberConnected || company.jobberNeedsReauth) return empty;
  if (inFlight.has(company.id)) return empty;
  inFlight.add(company.id);
  try {
    return await runInvoiceSync(company);
  } finally {
    inFlight.delete(company.id);
  }
}

async function runInvoiceSync(company: Company): Promise<InvoiceSyncResult> {
  const accessToken = await getValidAccessToken(company);

  // Re-read the cursor rather than trusting the passed-in row: the caller's
  // company object may predate the previous cycle's advance.
  const [cursorRow] = await db
    .select({ syncedThrough: companiesTable.jobberInvoicesSyncedThrough })
    .from(companiesTable)
    .where(eq(companiesTable.id, company.id));
  const syncedThrough = cursorRow?.syncedThrough ?? null;
  // Everything updated strictly before this instant is covered by a complete
  // pull; updates racing the pull land after it and the overlap re-reads them.
  const syncStartedAt = new Date();

  // Two modes, because an account can hold more history than one run's page
  // cap. Incremental (watermark set): filter on updatedAt as usual. Backfill
  // (no watermark yet): filter on createdAt instead — the sort is CREATED_AT
  // ASC, so a capped run's rows form a complete prefix and MAX(created) in
  // the mirror is exactly how far it got. The next run resumes from there
  // rather than re-reading the same first pages forever, which is how a
  // >MAX_PAGES history would otherwise permanently starve the later pages.
  const backfill = !syncedThrough;
  let filter: { updatedAt?: { after: string }; createdAt?: { after: string } };
  if (backfill) {
    const [floorRow] = await db
      .select({
        floor: sql<Date | null>`MAX(${jobberInvoicesTable.jobberCreatedAt})`,
      })
      .from(jobberInvoicesTable)
      .where(eq(jobberInvoicesTable.companyId, company.id));
    const floor = floorRow?.floor ? new Date(floorRow.floor) : null;
    // First pull reaches back to the pinned history floor — everything from
    // August 2026 onward, nothing older — instead of a drifting lookback.
    const after =
      floor && !Number.isNaN(floor.getTime()) ? floor : JOBBER_HISTORY_FLOOR;
    filter = { createdAt: { after: after.toISOString() } };
  } else {
    filter = {
      updatedAt: {
        after: new Date(syncedThrough.getTime() - OVERLAP_MS).toISOString(),
      },
    };
  }

  let cursor: string | null = null;
  let pages = 0;
  let complete = false;
  const nodes: JobberInvoiceNode[] = [];
  for (;;) {
    const data: InvoicesPage = await jobberGraphql<InvoicesPage>(
      accessToken,
      INVOICES_QUERY,
      {
        filter,
        first: PAGE_SIZE,
        after: cursor,
      },
    );
    const page = data.invoices;
    if (!page || !Array.isArray(page.nodes) || !page.pageInfo) {
      // "We don't know what Jobber has" — stop without claiming completeness.
      break;
    }
    nodes.push(...page.nodes);
    pages += 1;
    if (!page.pageInfo.hasNextPage) {
      complete = true;
      break;
    }
    if (pages >= MAX_PAGES) {
      logger.warn(
        { companyId: company.id, pages, count: nodes.length },
        "Jobber invoice sync hit its page cap; watermark held for next run",
      );
      break;
    }
    cursor = page.pageInfo.endCursor;
    if (!cursor) break;
  }

  let imported = 0;
  let updated = 0;
  const seenClients = new Map<
    string,
    { name: string; phone: string | null; jobberClientId: string }
  >();

  for (const node of nodes) {
    if (!node?.id) continue;
    const values = {
      companyId: company.id,
      jobberInvoiceId: node.id,
      invoiceNumber: node.invoiceNumber?.trim() || null,
      subject: node.subject?.trim() || null,
      clientName: invoiceClientName(node),
      clientPhone: node.client?.phone?.trim() || null,
      jobberClientId: node.client?.id ?? null,
      propertyAddress: invoicePropertyAddress(node),
      status: node.invoiceStatus?.trim() || "unknown",
      totalCents: toCents(node.amounts?.total),
      balanceCents: toCents(node.amounts?.invoiceBalance),
      jobberWebUri: node.jobberWebUri?.trim() || null,
      issuedAt: parseDate(node.issuedDate),
      dueAt: parseDate(node.dueDate),
      jobberCreatedAt: parseDate(node.createdAt),
      jobberUpdatedAt: parseDate(node.updatedAt),
      lastSyncedAt: new Date(),
    };
    const [existing] = await db
      .select({ id: jobberInvoicesTable.id })
      .from(jobberInvoicesTable)
      .where(
        and(
          eq(jobberInvoicesTable.companyId, company.id),
          eq(jobberInvoicesTable.jobberInvoiceId, node.id),
        ),
      )
      .limit(1);
    if (existing) {
      await db
        .update(jobberInvoicesTable)
        .set(values)
        .where(eq(jobberInvoicesTable.id, existing.id));
      updated += 1;
    } else {
      // Two sync processes can race the select (rolling deploy); the unique
      // index turns the loser into a no-op, updated on the next cycle.
      const inserted = await db
        .insert(jobberInvoicesTable)
        .values(values)
        .onConflictDoNothing()
        .returning({ id: jobberInvoicesTable.id });
      if (inserted.length > 0) imported += 1;
    }

    // An invoiced customer belongs in the client directory too — old clients
    // whose quotes and jobs predate the app only exist in Jobber's invoices.
    const clientName = invoiceClientName(node);
    if (node.client?.id && clientName && !seenClients.has(node.client.id)) {
      seenClients.set(node.client.id, {
        name: clientName,
        phone: node.client.phone,
        jobberClientId: node.client.id,
      });
    }
  }

  for (const c of seenClients.values()) {
    await recordClientContact(company.id, {
      name: c.name,
      phone: c.phone,
      jobberClientId: c.jobberClientId,
      source: "jobber",
    });
  }

  if (complete) {
    // A completing backfill sets the watermark behind its own start: earlier
    // capped runs mirrored rows that may have been updated since, and the
    // createdAt filter never re-read them. The slack covers that stretch.
    const watermark = backfill
      ? new Date(syncStartedAt.getTime() - BACKFILL_SLACK_MS)
      : syncStartedAt;
    // Conditional advance: two processes can run this concurrently (rolling
    // deploy); never let an older run's start time rewind a newer cursor.
    await db
      .update(companiesTable)
      .set({ jobberInvoicesSyncedThrough: watermark })
      .where(
        and(
          eq(companiesTable.id, company.id),
          or(
            isNull(companiesTable.jobberInvoicesSyncedThrough),
            lt(companiesTable.jobberInvoicesSyncedThrough, syncStartedAt),
          ),
        ),
      );
  }

  if (imported || updated) {
    logger.info(
      { companyId: company.id, imported, updated, count: nodes.length },
      "Jobber invoice sync complete",
    );
  }
  return { imported, updated, jobberCount: nodes.length, complete };
}
