/**
 * Pulls quotes created in Jobber into the local `jobber_quotes` mirror, so
 * the dashboard can show each quote's standing (draft / awaiting response /
 * approved / converted…) without opening Jobber.
 *
 * Read-only and incremental: rows are keyed by (company, jobberQuoteId) and
 * re-pulls update in place. The watermark is `jobberQuotesSyncedThrough` on
 * the company row — each run asks Jobber only for quotes updated since then
 * (minus a small overlap for clock skew), so steady state costs one small
 * page per cycle out of the shared Jobber rate budget. The first pull
 * reaches back a year.
 *
 * The watermark only advances when a run read every page Jobber offered,
 * and it is stored separately from the mirrored rows on purpose: a capped
 * run also writes rows, and pages arrive in CREATED_AT order (Jobber has no
 * updated-at sort), so a row-derived watermark could jump past updates on
 * the pages a capped run never saw. A capped run keeps the old watermark
 * and the next run re-covers the gap.
 *
 * Beyond the mirror, each pulled quote also maintains a *pending booking* so
 * the office can work Jobber-born quotes through the same accept-and-assign
 * flow as everything else. Direction discipline mirrors the request pull:
 * imported rows are keyed by `jobberSyncedQuoteId` only — `jobberQuoteId`
 * (the quote our outbound push raised) identifies bookings we pushed, which
 * are adopted rather than duplicated. Imported rows also get `jobberQuoteId`
 * stamped with the real Jobber quote id, which is exactly what lets the
 * accept flow schedule the job from Jobber's own quote — and what stops the
 * push from ever minting a second one.
 */
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  db,
  companiesTable,
  bookingsTable,
  jobberQuotesTable,
  leadsTable,
  activityTable,
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
 * How far behind MAX(mirrored createdAt) the next backfill run starts. Jobber
 * sorts by CREATED_AT ASC but Jobber's resolution is one second: multiple
 * quotes can share the same timestamp. If the page cap falls among a group of
 * equal-createdAt quotes, a strict `after=MAX` would exclude every quote in
 * that group not yet mirrored. Stepping back by one second re-reads the whole
 * group on the next run; the existing upsert deduplication absorbs any rows
 * that were already mirrored.
 */
const BACKFILL_CURSOR_OVERLAP_MS = 1_000;

export type JobberQuoteNode = {
  id: string;
  quoteNumber: number | null;
  title: string | null;
  quoteStatus: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  sentAt: string | null;
  transitionedAt: string | null;
  jobberWebUri: string | null;
  amounts: { total: number | null; subtotal?: number | null } | null;
  /** The Jobber request this quote was raised from, when there was one. */
  request: { id: string } | null;
  client: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
  } | null;
  property: {
    id?: string | null;
    address: {
      street: string | null;
      city: string | null;
      province: string | null;
      postalCode: string | null;
    } | null;
  } | null;
};

type QuotesPage = {
  quotes: {
    nodes: JobberQuoteNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  } | null;
};

const QUOTES_QUERY = `
  query SyncJobberQuotes($filter: QuoteFilterAttributes, $first: Int!, $after: String) {
    quotes(filter: $filter, first: $first, after: $after, sort: [{ key: CREATED_AT, direction: ASCENDING }]) {
      nodes {
        id
        quoteNumber
        title
        quoteStatus
        createdAt
        updatedAt
        sentAt
        transitionedAt
        jobberWebUri
        amounts { total subtotal }
        request { id }
        client { id firstName lastName phone }
        property { id address { street city province postalCode } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export type QuoteSyncResult = {
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
function toCents(total: number | null | undefined): number | null {
  if (typeof total !== "number" || !Number.isFinite(total)) return null;
  return Math.round(total * 100);
}

function quoteClientName(node: JobberQuoteNode): string | null {
  const name = [node.client?.firstName ?? "", node.client?.lastName ?? ""]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
  return name || null;
}

function quotePropertyAddress(node: JobberQuoteNode): string | null {
  const a = node.property?.address;
  if (!a) return null;
  const line = [a.street, a.city, a.province].filter(Boolean).join(", ");
  const full = [line, a.postalCode].filter(Boolean).join(" ").trim();
  return full || null;
}

/** One quote sync per company at a time; a slow pull must not stack. */
const inFlight = new Set<number>();

export async function syncCompanyJobberQuotes(
  company: Company,
): Promise<QuoteSyncResult> {
  const empty: QuoteSyncResult = {
    imported: 0,
    updated: 0,
    jobberCount: 0,
    complete: true,
  };
  if (!company.jobberConnected || company.jobberNeedsReauth) return empty;
  if (inFlight.has(company.id)) return empty;
  inFlight.add(company.id);
  try {
    return await runQuoteSync(company);
  } finally {
    inFlight.delete(company.id);
  }
}

async function runQuoteSync(company: Company): Promise<QuoteSyncResult> {
  const accessToken = await getValidAccessToken(company);

  // Re-read the cursor rather than trusting the passed-in row: the caller's
  // company object may predate the previous cycle's advance.
  const [cursorRow] = await db
    .select({
      syncedThrough: companiesTable.jobberQuotesSyncedThrough,
      backfillStartedAt: companiesTable.jobberQuotesBackfillStartedAt,
      backfillEndCursor: companiesTable.jobberQuotesBackfillEndCursor,
      backfillFilterFloor: companiesTable.jobberQuotesBackfillFilterFloor,
    })
    .from(companiesTable)
    .where(eq(companiesTable.id, company.id));
  const syncedThrough = cursorRow?.syncedThrough ?? null;
  // Everything updated strictly before this instant is covered by a complete
  // pull; updates racing the pull land after it and the overlap re-reads them.
  const syncStartedAt = new Date();

  // Two modes, because an account can hold more history than one run's page
  // cap. Incremental (watermark set): filter on updatedAt as usual. Backfill
  // (no watermark yet): filter on createdAt instead — the sort is CREATED_AT
  // ASC, so a capped run's rows form a complete prefix and MAX(createdAt) in
  // the mirror is exactly how far it got. The next run resumes from there
  // rather than re-reading the same first pages forever, which is how a
  // >MAX_PAGES history would otherwise permanently starve the later pages.
  const backfill = !syncedThrough;
  let filter: { updatedAt?: { after: string }; createdAt?: { after: string } };
  // The timestamp used to set the watermark at the end of a completing
  // backfill: we need this to be the start of the very first backfill run, not
  // just the completing run. Without it a multi-hour backfill would only
  // revisit updates from the last hour, silently missing status changes on
  // early rows that were mirrored long before the backfill finished.
  let backfillStartedAt = cursorRow?.backfillStartedAt ?? null;
  // The Jobber pagination cursor saved by the last capped backfill run, used
  // to resume mid-page-set rather than restarting the filter from the floor.
  // This is the only way to make progress when a tie group of quotes sharing
  // one createdAt second is larger than MAX_PAGES × PAGE_SIZE.
  const savedEndCursor = cursorRow?.backfillEndCursor ?? null;
  // The exact createdAt filter floor that was active when the saved cursor was
  // issued. Jobber cursors are query-scoped: a cursor from
  // { createdAt > "2024-01-01" } is only valid for subsequent pages of that
  // exact query. We persist the floor alongside the cursor and reuse it
  // unchanged until the chain completes. Only recalculate when starting fresh.
  const savedFilterFloor = cursorRow?.backfillFilterFloor ?? null;
  // The floor string passed to the createdAt filter for this run. Captured
  // here so it can be persisted atomically with the cap cursor after node
  // processing (the DB write only happens if all node writes succeed).
  let activeFilterFloor: string | null = null;
  if (backfill) {
    if (savedEndCursor && savedFilterFloor) {
      // Resuming a cursor chain: use the identical filter that produced this
      // cursor. Recalculating would break query-scoped cursor semantics.
      activeFilterFloor = savedFilterFloor;
      filter = { createdAt: { after: activeFilterFloor } };
    } else {
      // Fresh backfill (or no saved cursor): derive the floor from mirrored rows.
      const [floorRow] = await db
        .select({
          floor: sql<Date | null>`MAX(${jobberQuotesTable.jobberCreatedAt})`,
        })
        .from(jobberQuotesTable)
        .where(eq(jobberQuotesTable.companyId, company.id));
      const floor = floorRow?.floor ? new Date(floorRow.floor) : null;
      // First pull reaches back to the pinned history floor — everything
      // from August 2026 onward, nothing older — not a drifting lookback.
      const firstPullFloor = JOBBER_HISTORY_FLOOR;
      if (floor && !Number.isNaN(floor.getTime())) {
        // Step back by one second so ties at the capped boundary are re-read.
        // Jobber's createdAt resolution is one second; a group of quotes sharing
        // the max timestamp would all be excluded by a strict `after=MAX` if the
        // page cap fell inside that group. The upsert deduplicates the overlap.
        const after = new Date(floor.getTime() - BACKFILL_CURSOR_OVERLAP_MS);
        activeFilterFloor = after.toISOString();
      } else {
        activeFilterFloor = firstPullFloor.toISOString();
      }
      filter = { createdAt: { after: activeFilterFloor } };
    }
    // Record when this backfill started so the completing run can set the
    // watermark to cover the entire multi-run window, not just the last ten
    // minutes. Done for every entry into backfill mode (whether or not rows
    // exist), preserving the earliest value under concurrent runners.
    if (!backfillStartedAt) {
      backfillStartedAt = syncStartedAt;
      await db
        .update(companiesTable)
        .set({ jobberQuotesBackfillStartedAt: syncStartedAt })
        .where(
          and(
            eq(companiesTable.id, company.id),
            isNull(companiesTable.jobberQuotesBackfillStartedAt),
          ),
        );
    }
  } else {
    filter = {
      updatedAt: {
        after: new Date(syncedThrough.getTime() - OVERLAP_MS).toISOString(),
      },
    };
  }

  // Resume from the saved Jobber cursor when there is one. This skips the
  // already-mirrored portion of the current filter's result set, so a tie
  // group spanning more than MAX_PAGES × PAGE_SIZE quotes makes progress
  // across runs instead of looping forever on the same starting floor.
  let cursor: string | null = savedEndCursor;
  let pages = 0;
  let complete = false;
  // When the page cap fires, record the Jobber endCursor so the next run
  // can resume from exactly where this one stopped. Written after the loop
  // as a single awaited call rather than mid-loop so the write always lands
  // before any caller can observe the run as finished.
  let capEndCursor: string | null = null;
  const nodes: JobberQuoteNode[] = [];
  for (;;) {
    const data: QuotesPage = await jobberGraphql<QuotesPage>(
      accessToken,
      QUOTES_QUERY,
      {
        filter,
        first: PAGE_SIZE,
        after: cursor,
      },
    );
    const page = data.quotes;
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
        "Jobber quote sync hit its page cap; watermark held for next run",
      );
      capEndCursor = page.pageInfo.endCursor ?? null;
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
      jobberQuoteId: node.id,
      quoteNumber: node.quoteNumber ?? null,
      title: node.title?.trim() || null,
      clientName: quoteClientName(node),
      clientPhone: node.client?.phone?.trim() || null,
      jobberClientId: node.client?.id ?? null,
      propertyAddress: quotePropertyAddress(node),
      status: node.quoteStatus?.trim() || "unknown",
      totalCents: toCents(node.amounts?.total),
      jobberWebUri: node.jobberWebUri?.trim() || null,
      jobberCreatedAt: parseDate(node.createdAt),
      sentAt: parseDate(node.sentAt),
      transitionedAt: parseDate(node.transitionedAt),
      jobberUpdatedAt: parseDate(node.updatedAt),
      lastSyncedAt: new Date(),
    };
    const [existing] = await db
      .select({ id: jobberQuotesTable.id })
      .from(jobberQuotesTable)
      .where(
        and(
          eq(jobberQuotesTable.companyId, company.id),
          eq(jobberQuotesTable.jobberQuoteId, node.id),
        ),
      )
      .limit(1);
    if (existing) {
      await db
        .update(jobberQuotesTable)
        .set(values)
        .where(eq(jobberQuotesTable.id, existing.id));
      updated += 1;
    } else {
      // Two sync processes can race the select (rolling deploy); the unique
      // index turns the loser into a no-op, updated on the next cycle.
      const inserted = await db
        .insert(jobberQuotesTable)
        .values(values)
        .onConflictDoNothing()
        .returning({ id: jobberQuotesTable.id });
      if (inserted.length > 0) imported += 1;
    }

    // A quote born in Jobber also belongs on the Bookings page as a pending
    // booking. Best effort per node: a booking hiccup must not cost the
    // mirror row that already landed.
    try {
      await maintainBookingForQuote(company, node);
    } catch (err) {
      logger.warn(
        { err, companyId: company.id, jobberQuoteId: node.id },
        "Jobber quote sync: could not maintain the pending booking",
      );
    }

    // Every quoted customer belongs in the client directory too — quotes are
    // often the first time a new client exists anywhere.
    const clientName = quoteClientName(node);
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

  // Persist the cap cursor and its filter floor AFTER all node writes have
  // committed. If any node write threw above, this block is never reached and
  // the cursor stays null, so the next run re-fetches the same pages rather
  // than skipping them. Atomicity: both cursor and floor are written together
  // so the pair is always consistent — a cursor without its floor would cause
  // a query-scoped cursor to be reused with a different filter on the next run.
  // Uses raw SQL because Drizzle .set() can silently drop newly added nullable
  // text columns that have not yet been compiled into the cached schema.
  if (backfill && capEndCursor && activeFilterFloor) {
    await db.execute(
      sql`UPDATE companies
          SET "jobber_quotes_backfill_end_cursor"  = ${capEndCursor},
              "jobber_quotes_backfill_filter_floor" = ${activeFilterFloor}
          WHERE id = ${company.id}`,
    );
  }

  if (complete) {
    // A completing backfill sets the watermark back to when the backfill
    // began, minus the clock-skew overlap. That guarantees the first
    // watermark run re-reads anything that was updated after it was mirrored
    // by an early capped run — even in a multi-hour backfill where the
    // 1-hour heuristic would leave a gap. If backfillStartedAt was never
    // persisted (first run had no rows and lost the race to set it), fall
    // back to OVERLAP_MS behind syncStartedAt; that's safe because a
    // zero-row first run means the completing run is also the only run.
    const watermark = backfill
      ? new Date((backfillStartedAt ?? syncStartedAt).getTime() - OVERLAP_MS)
      : syncStartedAt;
    // Conditional advance: two processes can run this concurrently (rolling
    // deploy); never let an older run's start time rewind a newer cursor.
    await db
      .update(companiesTable)
      .set({
        jobberQuotesSyncedThrough: watermark,
        // Clear all three backfill markers now that the watermark covers the
        // window.
        jobberQuotesBackfillStartedAt: null,
        jobberQuotesBackfillEndCursor: null,
        jobberQuotesBackfillFilterFloor: null,
      })
      .where(
        and(
          eq(companiesTable.id, company.id),
          or(
            isNull(companiesTable.jobberQuotesSyncedThrough),
            lt(companiesTable.jobberQuotesSyncedThrough, syncStartedAt),
          ),
        ),
      );
  }

  if (imported || updated) {
    logger.info(
      { companyId: company.id, imported, updated, count: nodes.length },
      "Jobber quote sync complete",
    );
  }
  return { imported, updated, jobberCount: nodes.length, complete };
}

/**
 * A quote still in play. Converted (it became a job — the calendar pull
 * imports the visit) and archived are closed; everything else, including a
 * draft, is work the office may want in front of them.
 */
export function isOpenQuoteStatus(status: string | null | undefined): boolean {
  const s = (status ?? "").trim().toLowerCase();
  return s !== "converted" && s !== "archived";
}

/**
 * A quote pulled out of Jobber can be the answer to a lead still sitting in
 * the inbox: the customer asked on the company's Jobber form (a lead the
 * request import created), and the office priced it inside Jobber instead of
 * here. Once the import has a booking carrying that quote, the lead is
 * converted to it — otherwise the inbox keeps showing a "New" lead beside a
 * pending booking that already answers it, and "Create booking" on that card
 * would mint a duplicate.
 *
 * Same one-shot conditional claim as the manual convert route: only a lead
 * still "new" flips, so a replayed pull can't convert twice, a dismissed lead
 * is never resurrected, and a race with the office's own convert has exactly
 * one winner. The match is on the lead's *real* request id — a form lead
 * whose push is mid-flight holds a "pending:<ts>" claim marker in that
 * column, which can never equal a Jobber id, so mid-claim leads are left
 * alone by construction. The manual route's Jobber-id transfer is skipped on
 * purpose: an imported booking is born with Jobber's own client/property ids
 * and `jobberSynced`, so the transfer's every condition would refuse anyway.
 */
async function claimLeadForQuoteBooking(
  company: Company,
  requestId: string,
  bookingId: number,
): Promise<void> {
  const [claimed] = await db
    .update(leadsTable)
    .set({
      status: "converted",
      convertedBookingId: bookingId,
      convertedAt: new Date(),
    })
    .where(
      and(
        eq(leadsTable.companyId, company.id),
        eq(leadsTable.jobberRequestId, requestId),
        eq(leadsTable.status, "new"),
      ),
    )
    .returning();
  if (!claimed) return;
  // Point the booking back at its lead too (only filling a blank), exactly
  // as the manual convert does — the card's "View booking" link and the
  // outbound push's lead rules both read this.
  await db
    .update(bookingsTable)
    .set({ leadId: claimed.id })
    .where(and(eq(bookingsTable.id, bookingId), isNull(bookingsTable.leadId)));
  // Feed entry after the durable claim, so a lost race never announces.
  try {
    const name =
      [claimed.firstName ?? "", claimed.lastName ?? ""]
        .filter(Boolean)
        .join(" ") || "A lead";
    await db.insert(activityTable).values({
      companyId: company.id,
      type: "lead_converted",
      message: `${name} was converted into a booking by a quote made in Jobber`,
      bookingId,
    });
  } catch (err) {
    logger.error(
      { err, leadId: claimed.id, bookingId },
      "[jobber-quote-sync] lead-converted activity write failed",
    );
  }
}

/**
 * Keep the pending booking behind a Jobber-born quote true to the quote.
 *
 * Ordered from "ours" outward:
 *   1. A booking whose push raised this very quote (`jobberQuoteId`) is
 *      adopted — stamped with the inbound id, never duplicated.
 *   2. A booking this sync already imported is refreshed while it is still
 *      pending, and cancelled when Jobber closes the quote. Accepted rows
 *      belong to the office and are left alone.
 *   3. A quote raised from a request we know (imported or pushed) lands on
 *      that request's booking — one piece of work, one row — and brings the
 *      quote ids the accept flow needs to schedule from it.
 *   4. Only then is a new pending booking inserted, and only for open quotes.
 */
async function maintainBookingForQuote(
  company: Company,
  node: JobberQuoteNode,
): Promise<void> {
  const open = isOpenQuoteStatus(node.quoteStatus);

  const bookingRow = {
    id: bookingsTable.id,
    status: bookingsTable.status,
    customerPhone: bookingsTable.customerPhone,
    jobberSyncedQuoteId: bookingsTable.jobberSyncedQuoteId,
    jobberQuoteId: bookingsTable.jobberQuoteId,
  };

  // The linkage every imported row carries: the real Jobber quote id in
  // `jobberQuoteId` is what lets accept-and-assign schedule from the quote,
  // and what makes the outbound push refuse to mint a second one.
  const quoteLink = {
    jobberSyncedQuoteId: node.id,
    jobberQuoteId: node.id,
    jobberQuoteNumber:
      node.quoteNumber !== null && node.quoteNumber !== undefined
        ? String(node.quoteNumber)
        : null,
    jobberQuoteWebUri: node.jobberWebUri?.trim() || null,
  };
  const a = node.property?.address;
  // Jobber's subtotal matches `quotedAmount`'s meaning exactly: the price
  // before the app's fixed tax, from which the shown total is
  // derived. Storing the tax-inclusive total here would tax it twice.
  const subtotal =
    typeof node.amounts?.subtotal === "number" &&
    Number.isFinite(node.amounts.subtotal)
      ? node.amounts.subtotal
      : null;
  const fields = {
    customerName: quoteClientName(node) ?? "Jobber quote",
    service: node.title?.trim() || "Jobber quote",
    quotedAmount: subtotal,
    jobberClientId: node.client?.id ?? null,
    jobberPropertyId: node.property?.id ?? null,
  };
  const phone = node.client?.phone?.trim() || "";

  // 1. A booking this sync already imported. Checked BEFORE the pushed-row
  // lookup: imported rows carry `jobberQuoteId` too (that's what the accept
  // flow schedules from), and matching on it first would make every imported
  // row look pushed — and never let a closed quote cancel one.
  const [existing] = await db
    .select(bookingRow)
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.companyId, company.id),
        eq(bookingsTable.jobberSyncedQuoteId, node.id),
      ),
    )
    .limit(1);
  if (existing) {
    if (existing.status !== "pending") return;
    if (!open) {
      await db
        .update(bookingsTable)
        .set({ status: "canceled" })
        .where(
          and(
            eq(bookingsTable.id, existing.id),
            eq(bookingsTable.status, "pending"),
          ),
        );
      return;
    }
    await db
      .update(bookingsTable)
      .set({
        ...fields,
        ...quoteLink,
        customerPhone: phone || existing.customerPhone,
        ...(a?.street
          ? {
              customerAddress: a.street,
              addressCity: a.city,
              addressProvince: a.province,
              addressPostal: a.postalCode,
            }
          : {}),
      })
      .where(eq(bookingsTable.id, existing.id));
    // The lead may have arrived after the booking did (webhook ordering);
    // the conditional claim makes re-checking on every refresh harmless.
    if (node.request?.id) {
      await claimLeadForQuoteBooking(company, node.request.id, existing.id);
    }
    return;
  }

  // 2. The quote our own push raised, coming back on the pull. Adopt —
  // stamp the inbound id — never insert a second booking for it.
  const [pushedQuote] = await db
    .select(bookingRow)
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.companyId, company.id),
        eq(bookingsTable.jobberQuoteId, node.id),
      ),
    )
    .limit(1);
  if (pushedQuote) {
    if (!pushedQuote.jobberSyncedQuoteId) {
      await db
        .update(bookingsTable)
        .set({ jobberSyncedQuoteId: node.id })
        .where(
          and(
            eq(bookingsTable.id, pushedQuote.id),
            isNull(bookingsTable.jobberSyncedQuoteId),
          ),
        );
    }
    return;
  }

  // 3. A quote raised from a request the app knows: the imported request's
  // booking, or one whose request our push created. Same work, same row.
  if (node.request?.id) {
    const [fromRequest] = await db
      .select(bookingRow)
      .from(bookingsTable)
      .where(
        and(
          eq(bookingsTable.companyId, company.id),
          isNull(bookingsTable.jobberSyncedQuoteId),
          or(
            eq(bookingsTable.jobberSyncedRequestId, node.request.id),
            eq(bookingsTable.jobberJobId, node.request.id),
          ),
        ),
      )
      .limit(1);
    if (fromRequest) {
      await db
        .update(bookingsTable)
        .set({
          ...quoteLink,
          // Never clobber a quote id the push already holds (real or an
          // in-flight claim) — only fill the blank.
          ...(fromRequest.jobberQuoteId ? { jobberQuoteId: undefined } : {}),
          ...(fromRequest.status === "pending"
            ? { quotedAmount: subtotal }
            : {}),
        })
        .where(
          and(
            eq(bookingsTable.id, fromRequest.id),
            isNull(bookingsTable.jobberSyncedQuoteId),
          ),
        );
      await claimLeadForQuoteBooking(company, node.request.id, fromRequest.id);
      return;
    }
  }

  // 4. New to the app entirely.
  if (!open) return;
  const [inserted] = await db
    .insert(bookingsTable)
    .values({
      companyId: company.id,
      callId: null,
      ...fields,
      ...quoteLink,
      customerPhone: phone,
      customerAddress: a?.street ?? null,
      addressCity: a?.city ?? null,
      addressProvince: a?.province ?? null,
      addressPostal: a?.postalCode ?? null,
      // No scheduled time until the office accepts. Import time rather than
      // the quote's createdAt keeps an old-but-open quote above the Bookings
      // list's history floor on scheduledFor.
      scheduledFor: new Date(),
      status: "pending",
      jobberSynced: true,
    })
    // Rolling deploys run two syncs at once; the partial unique index on
    // (company_id, jobber_synced_quote_id) turns the loser into a no-op.
    .onConflictDoNothing()
    .returning({ id: bookingsTable.id });
  // Only the insert that won carries the lead over; the loser's winner will
  // do it itself (or the next pull's refresh path will).
  if (inserted && node.request?.id) {
    await claimLeadForQuoteBooking(company, node.request.id, inserted.id);
  }
}
