/**
 * Pulls work *requests* created in Jobber into the app as pending bookings,
 * so a request that starts life over there lands on the Bookings page and can
 * be worked through the same accept-and-assign flow as one the receptionist
 * took by phone.
 *
 * Direction discipline (the whole point of the separate columns):
 *   - An imported booking is keyed by `jobberSyncedRequestId` — never by
 *     `jobberJobId`, which holds the request id our OUTBOUND push minted. A
 *     request we pushed comes back around on this pull and is *adopted*
 *     (stamped, never re-inserted), so the office never sees two of it.
 *   - Rows this sync creates carry no `jobberVisitId`/`jobberSyncedJobId`, so
 *     the calendar sync's cancel-by-absence sweep can never touch them.
 *
 * Lifecycle: while the request is open in Jobber the pending booking tracks
 * it; once Jobber closes it (converted / archived / completed) a booking the
 * office never accepted is cancelled — a converted request comes back as a
 * scheduled visit through the calendar pull, and an accepted one already
 * belongs to the office. A booking whose quote has adopted it (see
 * jobberQuoteSync) is left to the quote's lifecycle.
 *
 * Incremental, same contract as the quote pull: watermark on the company row,
 * advanced only when a run read every page Jobber offered; pages are small on
 * purpose — the Jobber rate budget is shared across environments.
 *
 * The first pull (no watermark yet) is a resumable BACKFILL, because a
 * company can hold more post-floor requests than one run's page cap. The
 * sort is REQUESTED_AT while the filter is updatedAt, and imported requests
 * become bookings rather than mirror rows — so unlike the invoice pull no
 * row-derived floor can resume a capped run. Instead a capped run persists
 * Jobber's own pagination cursor (plus the exact filter it was issued
 * under; Jobber cursors are query-scoped) and the next run continues from
 * that page. The watermark a completing backfill sets reaches back to when
 * the backfill BEGAN, so anything updated mid-backfill — including rows a
 * cursor chain paged past — is re-read by the first incremental pull.
 *
 * Companies that already carry a watermark need no floor backfill: every
 * watermark ever minted came from a COMPLETE pull (capped runs hold it),
 * and until the floor pin those complete first pulls looked back 365 days —
 * far past the August 2026 floor — so no post-floor request can be missing
 * behind an existing watermark.
 */
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  db,
  companiesTable,
  bookingsTable,
  leadsTable,
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
 * A request still waiting for someone to act on it. Everything else —
 * converted (it became a quote/job), archived, completed — is closed and
 * must not sit on the Bookings page as work to accept.
 */
const OPEN_REQUEST_STATUSES = new Set([
  "new",
  "today",
  "upcoming",
  "overdue",
  "unscheduled",
  "assessment_completed",
]);

export function isOpenRequestStatus(
  status: string | null | undefined,
): boolean {
  return OPEN_REQUEST_STATUSES.has((status ?? "").trim().toLowerCase());
}

export type JobberRequestNode = {
  id: string;
  title: string | null;
  requestStatus: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  jobberWebUri: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  client: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
  } | null;
  property: {
    id: string;
    address: {
      street: string | null;
      city: string | null;
      province: string | null;
      postalCode: string | null;
    } | null;
  } | null;
};

type RequestsPage = {
  requests: {
    nodes: JobberRequestNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  } | null;
};

const REQUESTS_QUERY = `
  query SyncJobberRequests($filter: RequestFilterAttributes, $first: Int!, $after: String) {
    requests(filter: $filter, first: $first, after: $after, sort: [{ key: REQUESTED_AT, direction: ASCENDING }]) {
      nodes {
        id
        title
        requestStatus
        createdAt
        updatedAt
        jobberWebUri
        contactName
        phone
        email
        client { id firstName lastName phone }
        property { id address { street city province postalCode } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export type RequestSyncResult = {
  imported: number;
  updated: number;
  adopted: number;
  canceled: number;
  jobberCount: number;
  complete: boolean;
};

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The name the office will recognise on the booking card. */
export function requestCustomerName(node: JobberRequestNode): string {
  const person = [node.client?.firstName, node.client?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return person || node.contactName?.trim() || "Jobber request";
}

/** One request sync per company at a time; a slow pull must not stack. */
const inFlight = new Set<number>();

export async function syncCompanyJobberRequests(
  company: Company,
): Promise<RequestSyncResult> {
  const empty: RequestSyncResult = {
    imported: 0,
    updated: 0,
    adopted: 0,
    canceled: 0,
    jobberCount: 0,
    complete: true,
  };
  if (!company.jobberConnected || company.jobberNeedsReauth) return empty;
  if (inFlight.has(company.id)) return empty;
  inFlight.add(company.id);
  try {
    return await runRequestSync(company);
  } finally {
    inFlight.delete(company.id);
  }
}

async function runRequestSync(company: Company): Promise<RequestSyncResult> {
  const accessToken = await getValidAccessToken(company);

  // Re-read the cursor rather than trusting the passed-in row: the caller's
  // company object may predate the previous cycle's advance.
  const [cursorRow] = await db
    .select({
      syncedThrough: companiesTable.jobberRequestsSyncedThrough,
      backfillStartedAt: companiesTable.jobberRequestsBackfillStartedAt,
      backfillEndCursor: companiesTable.jobberRequestsBackfillEndCursor,
      backfillFilterFloor: companiesTable.jobberRequestsBackfillFilterFloor,
    })
    .from(companiesTable)
    .where(eq(companiesTable.id, company.id));
  const syncedThrough = cursorRow?.syncedThrough ?? null;
  const syncStartedAt = new Date();

  // Two modes (see the header): incremental behind the watermark, or a
  // resumable backfill from the pinned history floor when none exists yet.
  const backfill = !syncedThrough;
  // When the completing backfill sets the watermark it must reach back to
  // the START of the multi-run backfill, not just this run — rows imported
  // by an early capped run may have been updated since.
  let backfillStartedAt = cursorRow?.backfillStartedAt ?? null;
  // Jobber pagination cursor saved by the last capped backfill run, plus the
  // exact filter it was issued under. Cursors are query-scoped: resuming
  // must submit the identical filter or the cursor is meaningless.
  const savedEndCursor = backfill
    ? (cursorRow?.backfillEndCursor ?? null)
    : null;
  const savedFilterFloor = backfill
    ? (cursorRow?.backfillFilterFloor ?? null)
    : null;
  // First pull reaches back to the pinned history floor — everything from
  // August 2026 onward, nothing older — instead of a drifting lookback. A
  // resumed cursor chain reuses the floor string persisted with the cursor
  // (today identical to the constant, but the pair must travel together).
  const activeFilterFloor = backfill
    ? savedEndCursor && savedFilterFloor
      ? savedFilterFloor
      : JOBBER_HISTORY_FLOOR.toISOString()
    : new Date(syncedThrough!.getTime() - OVERLAP_MS).toISOString();
  if (backfill && !backfillStartedAt) {
    // Record when the backfill began, preserving the earliest value under
    // concurrent runners (rolling deploys run two of these).
    backfillStartedAt = syncStartedAt;
    await db
      .update(companiesTable)
      .set({ jobberRequestsBackfillStartedAt: syncStartedAt })
      .where(
        and(
          eq(companiesTable.id, company.id),
          isNull(companiesTable.jobberRequestsBackfillStartedAt),
        ),
      );
  }

  // Resume from the saved cursor when there is one — the only way a company
  // with more post-floor history than MAX_PAGES × PAGE_SIZE requests ever
  // reaches the later pages instead of re-reading the first ones forever.
  let cursor: string | null = savedEndCursor;
  let pages = 0;
  let complete = false;
  // When the page cap fires mid-backfill, the endCursor to persist so the
  // next run continues from exactly here. Written after node processing.
  let capEndCursor: string | null = null;
  const nodes: JobberRequestNode[] = [];
  for (;;) {
    const data: RequestsPage = await jobberGraphql<RequestsPage>(
      accessToken,
      REQUESTS_QUERY,
      {
        filter: { updatedAt: { after: activeFilterFloor } },
        first: PAGE_SIZE,
        after: cursor,
      },
    );
    const page = data.requests;
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
        { companyId: company.id, pages, count: nodes.length, backfill },
        "Jobber request sync hit its page cap; watermark held for next run",
      );
      if (backfill) capEndCursor = page.pageInfo.endCursor ?? null;
      break;
    }
    cursor = page.pageInfo.endCursor;
    if (!cursor) break;
  }

  let imported = 0;
  let updated = 0;
  let adopted = 0;
  let canceled = 0;
  // Booking writes that THREW — distinct from benign skips. A failed write
  // must hold back both the cap cursor and the watermark below: once the
  // cursor moves past a page (or the watermark past the backfill window),
  // those requests' dates never come around again, so an unwritten row
  // would be lost for good instead of retried on the next run.
  let persistFailures = 0;

  for (const node of nodes) {
    if (!node?.id) continue;
    try {
      const outcome = await maintainBookingForRequest(company, node);
      if (outcome === "imported") imported += 1;
      else if (outcome === "updated") updated += 1;
      else if (outcome === "adopted") adopted += 1;
      else if (outcome === "canceled") canceled += 1;
    } catch (err) {
      persistFailures += 1;
      logger.warn(
        { err, companyId: company.id, jobberRequestId: node.id },
        "Jobber request sync: could not import a request",
      );
    }
  }

  // Every requester belongs in the client directory — a request is often the
  // first time a new customer exists anywhere. Best effort by contract.
  const seenClients = new Map<string, JobberRequestNode>();
  for (const node of nodes) {
    if (node.client?.id && !seenClients.has(node.client.id)) {
      seenClients.set(node.client.id, node);
    }
  }
  for (const node of seenClients.values()) {
    const name = requestCustomerName(node);
    if (name === "Jobber request") continue;
    const a = node.property?.address;
    await recordClientContact(company.id, {
      name,
      phone: node.client?.phone ?? node.phone,
      streetAddress: a?.street,
      city: a?.city,
      province: a?.province,
      postalCode: a?.postalCode,
      jobberClientId: node.client!.id,
      source: "jobber",
    });
  }

  // Persist the cap cursor together with the filter it was issued under,
  // AFTER node processing and only when every processed node landed: a
  // failed write behind an advanced cursor would never be retried. Held
  // cursors just mean the next run re-fetches the same pages — the upsert
  // paths deduplicate the rows that did land. Uses raw SQL because Drizzle
  // .set() can silently drop newly added nullable text columns not yet
  // compiled into the cached schema.
  if (backfill && capEndCursor && persistFailures > 0) {
    logger.warn(
      { companyId: company.id, persistFailures },
      "Jobber request backfill: cursor withheld — a booking write failed; the page chain will be re-read next run",
    );
  }
  if (backfill && capEndCursor && persistFailures === 0) {
    await db.execute(
      sql`UPDATE companies
          SET "jobber_requests_backfill_end_cursor"   = ${capEndCursor},
              "jobber_requests_backfill_filter_floor" = ${activeFilterFloor}
          WHERE id = ${company.id}`,
    );
  }

  if (complete && persistFailures > 0) {
    // Every page was read, but not every row landed. Advancing the watermark
    // now would put the failed requests behind it forever; hold it and let
    // the next run re-read the window.
    logger.warn(
      { companyId: company.id, persistFailures, backfill },
      "Jobber request sync: watermark withheld — a booking write failed; the window will be re-read next run",
    );
    complete = false;
  }
  if (complete) {
    // A completing backfill sets the watermark back to when the backfill
    // BEGAN (minus the clock-skew overlap): rows imported by an early capped
    // run — and rows a resumed cursor chain paged past after they were
    // updated mid-backfill — are all re-read by the first incremental pull.
    // If backfillStartedAt was somehow never persisted, fall back to this
    // run's start; a single-run backfill needs no wider window.
    const watermark = backfill
      ? new Date((backfillStartedAt ?? syncStartedAt).getTime() - OVERLAP_MS)
      : syncStartedAt;
    // Conditional advance: never let an older run's start time rewind a
    // newer cursor (rolling deploys run two of these concurrently).
    await db
      .update(companiesTable)
      .set({
        jobberRequestsSyncedThrough: watermark,
        // The watermark now covers the whole backfill window; the markers
        // have done their job.
        jobberRequestsBackfillStartedAt: null,
        jobberRequestsBackfillEndCursor: null,
        jobberRequestsBackfillFilterFloor: null,
      })
      .where(
        and(
          eq(companiesTable.id, company.id),
          or(
            isNull(companiesTable.jobberRequestsSyncedThrough),
            lt(companiesTable.jobberRequestsSyncedThrough, syncStartedAt),
          ),
        ),
      );
  }

  if (imported || updated || adopted || canceled) {
    logger.info(
      {
        companyId: company.id,
        imported,
        updated,
        adopted,
        canceled,
        count: nodes.length,
      },
      "Jobber request sync complete",
    );
  }
  return {
    imported,
    updated,
    adopted,
    canceled,
    jobberCount: nodes.length,
    complete,
  };
}

async function maintainBookingForRequest(
  company: Company,
  node: JobberRequestNode,
): Promise<"imported" | "updated" | "adopted" | "canceled" | "skipped"> {
  const open = isOpenRequestStatus(node.requestStatus);

  // A request our own push created. Adopt — stamp the inbound id — never
  // insert a second booking for work the app already has.
  const [pushed] = await db
    .select({
      id: bookingsTable.id,
      jobberSyncedRequestId: bookingsTable.jobberSyncedRequestId,
    })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.companyId, company.id),
        eq(bookingsTable.jobberJobId, node.id),
      ),
    )
    .limit(1);
  if (pushed) {
    if (!pushed.jobberSyncedRequestId) {
      await db
        .update(bookingsTable)
        .set({ jobberSyncedRequestId: node.id })
        .where(
          and(
            eq(bookingsTable.id, pushed.id),
            isNull(bookingsTable.jobberSyncedRequestId),
          ),
        );
      return "adopted";
    }
    return "skipped";
  }

  // A request a form LEAD's own push created (a website-form enquiry not
  // yet converted to a booking — once converted, the booking carries the
  // same request id and is adopted above). Importing it would put one
  // enquiry on the office's plate twice: once as the lead in the inbox,
  // once as a pending booking that cloning sweep rules would then manage.
  // Scoped to form leads on purpose: a jobber-source lead's request may
  // legitimately have a pre-switchover booking twin that still needs its
  // lifecycle managed below (the jobber-lead skip guards only creation).
  const [pushedLead] = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.companyId, company.id),
        eq(leadsTable.source, "form"),
        eq(leadsTable.jobberRequestId, node.id),
      ),
    )
    .limit(1);
  if (pushedLead) return "skipped";

  const [existing] = await db
    .select({
      id: bookingsTable.id,
      status: bookingsTable.status,
      customerPhone: bookingsTable.customerPhone,
      customerAddress: bookingsTable.customerAddress,
      jobberSyncedQuoteId: bookingsTable.jobberSyncedQuoteId,
    })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.companyId, company.id),
        eq(bookingsTable.jobberSyncedRequestId, node.id),
      ),
    )
    .limit(1);

  const a = node.property?.address;
  const fields = {
    customerName: requestCustomerName(node),
    customerEmail: node.email?.trim() || null,
    service: node.title?.trim() || "Jobber request",
    jobberClientId: node.client?.id ?? null,
    jobberPropertyId: node.property?.id ?? null,
    jobberWebUri: node.jobberWebUri?.trim() || null,
  };
  const phone = node.client?.phone?.trim() || node.phone?.trim() || "";

  if (existing) {
    // Only a booking still waiting on the office is the sync's to manage.
    // Accepted (confirmed), completed or hand-cancelled rows belong to the
    // office; and once a Jobber quote has adopted this row, the quote's own
    // pull drives its lifecycle.
    if (existing.status !== "pending") return "skipped";
    if (existing.jobberSyncedQuoteId) return "skipped";
    if (!open) {
      // Converted comes back as a scheduled visit through the calendar pull;
      // archived/completed is dead. Cancel, never delete — history survives.
      await db
        .update(bookingsTable)
        .set({ status: "canceled" })
        .where(
          and(
            eq(bookingsTable.id, existing.id),
            eq(bookingsTable.status, "pending"),
          ),
        );
      return "canceled";
    }
    // Jobber knowing less than we do must not erase what we know: a request
    // that comes back without a phone or address leaves the booking's own
    // details standing.
    await db
      .update(bookingsTable)
      .set({
        ...fields,
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
    return "updated";
  }

  if (!open) return "skipped";

  // New Jobber-form enquiries live in the Leads inbox now (webhook + sweep,
  // services/jobberRequestLeads.ts) — leads win for brand-new requests. A
  // request already sitting there as a lead must not ALSO become a pending
  // booking, whatever the lead's status: a dismissed enquiry stays
  // dismissed, and a converted one already made its booking.
  const [lead] = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.companyId, company.id),
        eq(leadsTable.jobberRequestId, node.id),
      ),
    )
    .limit(1);
  if (lead) return "skipped";

  const inserted = await db
    .insert(bookingsTable)
    .values({
      companyId: company.id,
      callId: null,
      ...fields,
      customerPhone: phone,
      customerAddress: a?.street ?? null,
      addressCity: a?.city ?? null,
      addressProvince: a?.province ?? null,
      addressPostal: a?.postalCode ?? null,
      // A request has no scheduled time yet — that's what accepting is for.
      // Import time (not the request's createdAt) keeps an old-but-open
      // request visible: the Bookings list has a history floor on
      // scheduledFor, and a date months in the past would hide the row the
      // office most needs to see.
      scheduledFor: new Date(),
      status: "pending",
      // Marked synced (and carrying no quote id), so the outbound push knows
      // this work is already in Jobber and never mints a duplicate request.
      jobberSynced: true,
      jobberSyncedRequestId: node.id,
    })
    // Two sync processes can race the select above (rolling deploy); the
    // partial unique index turns the loser's insert into a no-op.
    .onConflictDoNothing()
    .returning({ id: bookingsTable.id });
  return inserted.length > 0 ? "imported" : "skipped";
}
