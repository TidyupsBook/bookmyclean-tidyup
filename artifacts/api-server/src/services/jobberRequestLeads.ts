/**
 * Jobber-form requests land in the Leads inbox.
 *
 * Two doors feed one import path:
 *   - the REQUEST_CREATE webhook (routes/jobberWebhook.ts), seconds after the
 *     customer submits the form, and
 *   - `sweepJobberRequestLeads`, a short-window pull that rides the Jobber
 *     sync cycle as a safety net for deliveries Jobber never managed to make.
 *
 * Both call `importJobberRequestLead`, so a request the webhook already
 * handled cannot be duplicated by the sweep (and vice versa): the lead's
 * (company, externalId) unique index makes the insert idempotent, and the
 * guards below keep our own requests from boomeranging back as leads.
 *
 * Never boomerang our own work:
 *   - a request our outbound booking push minted is recognised by
 *     `jobberJobId` on a booking (that column holds the request id the push
 *     created);
 *   - a request the outbound LEAD push minted is recognised by
 *     `jobberRequestId` on a non-Jobber-origin lead (leadJobberPush.ts);
 *   - a request already imported as a pending booking (the request pull) is
 *     recognised by `jobberSyncedRequestId`;
 *   - the race where the webhook outruns our own push writing its id down is
 *     closed from both sides: this import re-checks after inserting and
 *     deletes its own insert if the push's id has appeared, and both pushes
 *     delete any echo lead after recording their id (deleteEchoLeads).
 *
 * Everything the customer typed is stored verbatim — their message is never
 * parsed into a scheduled time.
 */
import { and, eq, ne, or } from "drizzle-orm";
import {
  db,
  leadsTable,
  bookingsTable,
  activityTable,
  type Company,
} from "@workspace/db";
import {
  getValidAccessToken,
  jobberGraphql,
  fetchJobberRequestDetails,
  type JobberRequestDetails,
} from "../lib/jobber";
import { isOpenRequestStatus } from "./jobberRequestSync";
import { toE164 } from "../lib/quo";
import { logger } from "../lib/logger";

/** The fixed `sourceTab` label Jobber-origin leads wear in the inbox. */
export const JOBBER_LEAD_SOURCE_TAB = "Jobber request";

/** How far back the sweep looks for requests whose webhook never arrived. */
const SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Small pages on purpose — the Jobber rate budget is shared. */
const SWEEP_PAGE_SIZE = 20;
const SWEEP_MAX_PAGES = 3;

export type JobberLeadImportOutcome =
  | "imported"
  | "duplicate" // a lead for this request already exists
  | "skipped_ours" // a booking already carries this request's id
  | "skipped_closed"; // the request is no longer open in Jobber

/** Does any booking already account for this Jobber request? */
async function requestAlreadyOnABooking(
  companyId: number,
  requestId: string,
): Promise<boolean> {
  const [existing] = await db
    .select({ id: bookingsTable.id })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.companyId, companyId),
        // `jobberJobId` holds the request id our OUTBOUND push minted;
        // `jobberSyncedRequestId` marks a request already imported as a
        // pending booking. Either way the app already has this work.
        or(
          eq(bookingsTable.jobberJobId, requestId),
          eq(bookingsTable.jobberSyncedRequestId, requestId),
        ),
      ),
    )
    .limit(1);
  return Boolean(existing);
}

/**
 * Is this request already the app's own work? Either a booking carries it,
 * or a lead WE pushed to Jobber minted it (the outbound lead push writes the
 * request id it created back onto the form lead). Without the lead-side
 * check, our own push's REQUEST_CREATE webhook boomerangs the same enquiry
 * back into the inbox as a second, Jobber-origin lead.
 */
async function requestIsOurs(
  companyId: number,
  requestId: string,
): Promise<boolean> {
  if (await requestAlreadyOnABooking(companyId, requestId)) return true;
  const [pushedLead] = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.companyId, companyId),
        eq(leadsTable.jobberRequestId, requestId),
        // A Jobber-origin lead carrying this id is the import row itself;
        // any other source means our own push created the request.
        ne(leadsTable.source, "jobber"),
      ),
    )
    .limit(1);
  return Boolean(pushedLead);
}

/** The customer's own message: the request's first note, verbatim. */
function requestMessage(detail: JobberRequestDetails): string | null {
  for (const note of detail.notes?.nodes ?? []) {
    const message = note?.message?.trim();
    if (message) return message;
  }
  return null;
}

/**
 * Store one Jobber request as a Jobber-origin lead. Shared by the webhook
 * and the sweep; safe to call any number of times for the same request.
 */
export async function importJobberRequestLead(
  company: Company,
  detail: JobberRequestDetails,
): Promise<JobberLeadImportOutcome> {
  // A request that is no longer open was already handled in Jobber (or was
  // converted/archived before we got here) — not an enquiry to triage.
  if (!isOpenRequestStatus(detail.requestStatus)) return "skipped_closed";

  if (await requestIsOurs(company.id, detail.id)) {
    return "skipped_ours";
  }

  const address = detail.property?.address ?? null;
  const phone = detail.client?.phone?.trim() || detail.phone?.trim() || null;
  // Names verbatim: the client's first/last when Jobber has them, otherwise
  // whatever contact name the form captured.
  const firstName =
    detail.client?.firstName?.trim() || detail.contactName?.trim() || null;
  const lastName = detail.client?.lastName?.trim() || null;

  const inserted = await db
    .insert(leadsTable)
    .values({
      companyId: company.id,
      source: "jobber",
      externalId: detail.id,
      sourceTab: JOBBER_LEAD_SOURCE_TAB,
      firstName,
      lastName,
      phoneNumber: phone,
      phoneE164: phone ? toE164(phone) : null,
      email: detail.email?.trim() || null,
      streetAddress: address?.street?.trim() || null,
      city: address?.city?.trim() || null,
      province: address?.province?.trim() || null,
      postCode: address?.postalCode?.trim() || null,
      // The request title is what they asked for; their own words ride in
      // `message`. Both verbatim, never parsed.
      service: detail.title?.trim() || null,
      message: requestMessage(detail),
      // Raw ISO string, same convention as the sheet's created_time.
      createdTime: detail.createdAt ?? null,
      jobberRequestId: detail.id,
      jobberClientId: detail.client?.id ?? null,
      jobberPropertyId: detail.property?.id ?? null,
      jobberWebUri: detail.jobberWebUri?.trim() || null,
    })
    // The (company, externalId) unique index makes replays and the
    // webhook-vs-sweep race collapse into one row.
    .onConflictDoNothing({
      target: [leadsTable.companyId, leadsTable.externalId],
    })
    .returning({ id: leadsTable.id });

  if (inserted.length === 0) return "duplicate";
  const leadId = inserted[0]!.id;

  // Close the race with our own push from this side too: if the push's id
  // write landed while we were importing, this lead is an echo of a request
  // WE created — take it back out. (The push deletes echo leads from its
  // side as well; deleting twice is harmless.)
  if (await requestIsOurs(company.id, detail.id)) {
    await db.delete(leadsTable).where(eq(leadsTable.id, leadId));
    return "skipped_ours";
  }

  // Feed line after the durable insert — a courtesy that must never fail
  // the import.
  try {
    const name =
      [firstName, lastName].filter(Boolean).join(" ") || "A new customer";
    await db.insert(activityTable).values({
      companyId: company.id,
      type: "lead_request_received",
      message: `${name} sent a cleaning request through the Jobber form`,
    });
  } catch (err) {
    logger.error({ err, leadId }, "[jobber-leads] activity write failed");
  }

  // Nudge the geocoder so the new lead lands on the Leads map within
  // moments. Fire-and-forget, and NEVER in tests: the suite shares the dev
  // DB and injects a null-returning stub geocoder — letting this run there
  // would cache "unplaceable" for real addresses.
  if (process.env["NODE_ENV"] !== "test") {
    void import("./geocodeBackfill").then(({ runGeocodeBackfill }) =>
      runGeocodeBackfill().catch((err) =>
        logger.warn({ err }, "[jobber-leads] post-import geocode pass failed"),
      ),
    );
  }

  return "imported";
}

type SweepPage = {
  requests: {
    nodes: Array<{ id: string; requestStatus: string | null } | null>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  } | null;
};

/**
 * Ids first, details only for genuine candidates: most cycles every recent
 * request is already a lead or a booking, and the sweep costs one small
 * id-only query. Only a request the webhook truly missed pays for the
 * detail read.
 *
 * NEWEST first, deliberately: the sweep is capped at a few small pages, so
 * on a busy account with more than a page-cap's worth of requests in the
 * window, oldest-first would spend every cycle re-examining the same old
 * already-handled rows and never reach a fresh request whose webhook was
 * missed. Newest-first means a just-missed delivery is on page one of the
 * very next sweep — and anything older already had page-one treatment in
 * the cycles when it was newest.
 */
const SWEEP_QUERY = `
  query SweepRecentRequests($filter: RequestFilterAttributes, $first: Int!, $after: String) {
    requests(filter: $filter, first: $first, after: $after, sort: [{ key: REQUESTED_AT, direction: DESCENDING }]) {
      nodes { id requestStatus }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export type JobberLeadSweepResult = { imported: number; checked: number };

/** One sweep per company at a time; a slow pull must not stack. */
const inFlight = new Set<number>();

/**
 * The safety net: pull requests created in the last day and feed any the
 * webhook missed through the same import path. Short window, small pages —
 * the rate budget is shared across environments and pollers.
 */
export async function sweepJobberRequestLeads(
  company: Company,
): Promise<JobberLeadSweepResult> {
  const empty: JobberLeadSweepResult = { imported: 0, checked: 0 };
  if (!company.jobberConnected || company.jobberNeedsReauth) return empty;
  if (inFlight.has(company.id)) return empty;
  inFlight.add(company.id);
  try {
    return await runSweep(company);
  } finally {
    inFlight.delete(company.id);
  }
}

async function runSweep(company: Company): Promise<JobberLeadSweepResult> {
  const accessToken = await getValidAccessToken(company);
  const after = new Date(Date.now() - SWEEP_WINDOW_MS);

  const candidates: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
    const data: SweepPage = await jobberGraphql<SweepPage>(
      accessToken,
      SWEEP_QUERY,
      {
        filter: { createdAt: { after: after.toISOString() } },
        first: SWEEP_PAGE_SIZE,
        after: cursor,
      },
    );
    const nodes = data.requests?.nodes ?? [];
    for (const node of nodes) {
      if (node?.id && isOpenRequestStatus(node.requestStatus)) {
        candidates.push(node.id);
      }
    }
    if (!data.requests?.pageInfo?.hasNextPage) break;
    cursor = data.requests.pageInfo.endCursor;
    if (!cursor) break;
  }

  let imported = 0;
  for (const requestId of candidates) {
    try {
      // Cheap local checks before spending rate budget on the detail read.
      const [existingLead] = await db
        .select({ id: leadsTable.id })
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.companyId, company.id),
            eq(leadsTable.externalId, requestId),
          ),
        )
        .limit(1);
      if (existingLead) continue;
      if (await requestIsOurs(company.id, requestId)) continue;

      const detail = await fetchJobberRequestDetails(accessToken, requestId);
      if (!detail) continue;
      const outcome = await importJobberRequestLead(company, detail);
      if (outcome === "imported") imported += 1;
    } catch (err) {
      logger.warn(
        { err, companyId: company.id, jobberRequestId: requestId },
        "Jobber lead sweep: could not import a request",
      );
    }
  }

  if (imported > 0) {
    logger.info(
      { companyId: company.id, imported, checked: candidates.length },
      "Jobber lead sweep picked up missed requests",
    );
  }
  return { imported, checked: candidates.length };
}
