/**
 * Production-only safety net for website-form leads whose first Jobber push
 * failed. The inbox still offers a manual retry; this poller is for outages
 * that recover while nobody is watching the dashboard.
 *
 * The failure timestamp is the retry anchor and the durable attempt count
 * selects an exponential cooldown. A bounded count is intentional: a request
 * Jobber will never accept should not create an outbound storm forever.
 */
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { db, companiesTable, leadsTable, type Lead } from "@workspace/db";
import { logger } from "../lib/logger";
import { queueLeadPush } from "./leadJobberPush";

/** One hourly pass, matching the pending-texts retry cadence. */
export const LEAD_JOBBER_RETRY_INTERVAL_MS = 60 * 60 * 1000;
/** Let migrations and the first burst of startup traffic settle. */
export const LEAD_JOBBER_RETRY_INITIAL_DELAY_MS = 75 * 1000;
/** Automatic retries stop here; the inbox's manual action remains available. */
export const LEAD_JOBBER_MAX_AUTOMATIC_ATTEMPTS = 5;
/** The first retry waits one sweep interval, then the delay doubles. */
export const LEAD_JOBBER_RETRY_BASE_DELAY_MS = LEAD_JOBBER_RETRY_INTERVAL_MS;
/** Do not make a single lead wait longer than a day between automatic tries. */
export const LEAD_JOBBER_RETRY_MAX_DELAY_MS = 24 * 60 * 60 * 1000;

export function leadJobberRetryDelayMs(attempts: number): number {
  const safeAttempts = Math.max(1, Math.floor(attempts));
  return Math.min(
    LEAD_JOBBER_RETRY_MAX_DELAY_MS,
    LEAD_JOBBER_RETRY_BASE_DELAY_MS * 2 ** (safeAttempts - 1),
  );
}

export function leadJobberRetryDue(
  lead: Pick<Lead, "jobberPushErrorAt" | "jobberPushAttempts">,
  nowMs: number = Date.now(),
): boolean {
  if (!lead.jobberPushErrorAt) return false;
  if (
    lead.jobberPushAttempts < 1 ||
    lead.jobberPushAttempts >= LEAD_JOBBER_MAX_AUTOMATIC_ATTEMPTS
  ) {
    return false;
  }
  return (
    lead.jobberPushErrorAt.getTime() +
      leadJobberRetryDelayMs(lead.jobberPushAttempts) <=
    nowMs
  );
}

/**
 * Retry all due form leads for connected companies. The lead push's claim is
 * still the concurrency guard: this query may overlap a manual retry or
 * another process, but only the caller that claims the lead can call Jobber.
 */
export async function runLeadJobberRetryCycle(
  nowMs: number = Date.now(),
): Promise<number> {
  const rows = await db
    .select({ lead: leadsTable, company: companiesTable })
    .from(leadsTable)
    .innerJoin(companiesTable, eq(leadsTable.companyId, companiesTable.id))
    .where(
      and(
        eq(companiesTable.jobberConnected, true),
        eq(companiesTable.jobberNeedsReauth, false),
        eq(leadsTable.source, "form"),
        eq(leadsTable.jobberSynced, false),
        eq(leadsTable.status, "new"),
        isNotNull(leadsTable.jobberPushError),
        isNotNull(leadsTable.jobberPushErrorAt),
        lt(leadsTable.jobberPushAttempts, LEAD_JOBBER_MAX_AUTOMATIC_ATTEMPTS),
      ),
    )
    .orderBy(leadsTable.id);

  let queued = 0;
  for (const { lead, company } of rows) {
    if (!leadJobberRetryDue(lead, nowMs)) continue;
    queued += 1;
    try {
      await queueLeadPush(company, lead);
    } catch (err) {
      // queueLeadPush normally returns a result, but a sweep must keep moving
      // if a future change lets an unexpected error escape one lead.
      logger.warn(
        { err, companyId: company.id, leadId: lead.id },
        "[leadJobberRetry] retry failed unexpectedly; continuing",
      );
    }
  }
  if (queued > 0) {
    logger.info({ queued }, "[leadJobberRetry] automatic lead retries queued");
  }
  return queued;
}

let timer: NodeJS.Timeout | null = null;
let cycleInFlight = false;

/** Start the background retry only in the published environment. */
export function startLeadJobberRetry(): void {
  if (!process.env["PUBLIC_APP_URL"]?.trim()) {
    logger.info(
      "[leadJobberRetry] background retry disabled: no PUBLIC_APP_URL pin (dev workspace)",
    );
    return;
  }
  if (timer) return;
  const run = () => {
    if (cycleInFlight) return;
    cycleInFlight = true;
    runLeadJobberRetryCycle()
      .catch((err) =>
        logger.error({ err }, "[leadJobberRetry] retry cycle failed"),
      )
      .finally(() => {
        cycleInFlight = false;
      });
  };
  setTimeout(run, LEAD_JOBBER_RETRY_INITIAL_DELAY_MS).unref();
  timer = setInterval(run, LEAD_JOBBER_RETRY_INTERVAL_MS);
  timer.unref();
  logger.info(
    { intervalMs: LEAD_JOBBER_RETRY_INTERVAL_MS },
    "[leadJobberRetry] background retry started",
  );
}
