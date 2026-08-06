import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  companiesTable,
  teamMembersTable,
  type Company,
} from "@workspace/db";
import { listPhoneNumbers, QuoError } from "./quo";
import { decryptQuoKey } from "./secretBox";
import { notifyOwnerQuoKeyDead, notifyOwnerQuoRestored } from "./ownerNotify";
import { logger } from "./logger";
import { jobberRedirectUri } from "./publicUrl";

/**
 * The company this account works for — either because they own it or because
 * they hold a team seat in it.
 *
 * SCOPE ONLY, NOT PERMISSION. This answers "whose data is this request about",
 * and it now returns a company for cleaners and dispatchers too. It does NOT
 * say the caller may act on it — every route must declare the roles it accepts
 * with `requireRole`, or a cleaner inherits the owner's whole dashboard.
 */
export async function getCompanyForUser(
  userId: string,
): Promise<Company | undefined> {
  const { resolveCaller } = await import("./callerRole");
  const caller = await resolveCaller(userId);
  return caller.company ?? undefined;
}

/** The company's decrypted Quo key, or null if they have not connected one. */
export function companyQuoKey(company: Company): string | null {
  return decryptQuoKey(company.quoApiKeyEncrypted);
}

/**
 * Same, but throws a 503-shaped QuoError when the key is missing or no longer
 * decryptable, so routes surface "reconnect Quo" rather than a generic failure.
 */
export function requireCompanyQuoKey(company: Company): string {
  const key = companyQuoKey(company);
  if (!key) {
    throw new QuoError("This company needs to reconnect its Quo account", 503);
  }
  return key;
}

/** True when the error means Quo rejected the key itself (revoked/rotated). */
export function isQuoAuthError(err: unknown): boolean {
  return err instanceof QuoError && (err.status === 401 || err.status === 403);
}
export async function serializeCompany(company: Company) {
  const team = await db
    .select()
    .from(teamMembersTable)
    .where(eq(teamMembersTable.companyId, company.id));

  const teamInvited = team.some((m) => m.role !== "owner");
  // A line is "provisioned" once the receptionist is watching at least one
  // real Quo number.
  const phoneProvisioned = company.quoNumberIds.length > 0;

  let watchedNumbers: Array<{
    id: string;
    phoneNumber: string;
    name: string;
    watched: boolean;
  }> = [];
  const quoKey = companyQuoKey(company);
  if (quoKey && company.quoNumberIds.length > 0) {
    try {
      const numbers = await listPhoneNumbers(quoKey);
      await setQuoNeedsReauth(company, false);
      watchedNumbers = numbers
        .filter((n) => company.quoNumberIds.includes(n.id))
        .map((n) => ({
          id: n.id,
          phoneNumber: n.number,
          name: n.name ?? n.number,
          watched: true,
        }));
    } catch (err) {
      // A 401/403 means the key itself is dead — record it so the dashboard
      // can warn the owner instead of failing silently.
      if (isQuoAuthError(err)) await setQuoNeedsReauth(company, true);
      // Quo being unreachable must not break the dashboard; fall back to ids.
      watchedNumbers = company.quoNumberIds.map((id) => ({
        id,
        phoneNumber: "",
        name: id,
        watched: true,
      }));
    }
  }

  // Jobber is optional: connecting it or deliberately skipping it both count
  // as having dealt with the step, so the wizard stops blocking either way.
  const jobberResolved = company.jobberConnected || company.jobberSkipped;

  const steps = [
    true, // account created
    jobberResolved,
    phoneProvisioned,
    company.receptionistConfigured,
    teamInvited,
    company.isLive,
  ];

  return {
    id: company.id,
    name: company.name,
    greeting: company.greeting,
    collectFields: company.collectFields,
    customQuestions: company.customQuestions,
    ringThroughNumber: company.ringThroughNumber,
    notificationNumber: company.notificationNumber,
    // Raw values the startup cleanup pass removed because they can't receive
    // texts — settings shows a warning until the owner saves a replacement.
    ringThroughNumberRejected: company.ringThroughNumberRejected,
    notificationNumberRejected: company.notificationNumberRejected,
    phoneNumber: watchedNumbers[0]?.phoneNumber || company.phoneNumber,
    timezone: company.timezone,
    jobberConnected: company.jobberConnected,
    jobberSkipped: company.jobberSkipped,
    jobberAccountName: company.jobberAccountName,
    jobberNeedsReauth: company.jobberNeedsReauth,
    jobberRedirectUri: jobberRedirectUri(),
    quoConnected: company.quoConnected,
    quoWorkspaceName: company.quoWorkspaceName,
    quoKeyLast4: company.quoKeyLast4,
    quoNeedsReauth: company.quoNeedsReauth,
    quoteRateSolo: company.quoteRateSolo,
    quoteRateTeam: company.quoteRateTeam,
    quoteFuelSurcharge: company.quoteFuelSurcharge,
    quoteTaxLabel: company.quoteTaxLabel,
    quoteTaxRate: company.quoteTaxRate,
    quoteFeesLabel: company.quoteFeesLabel,
    quoteFeesRate: company.quoteFeesRate,
    quoteDepositAmount: company.quoteDepositAmount,
    quoteDepositEmail: company.quoteDepositEmail,
    watchedNumbers,
    isLive: company.isLive,
    setupStatus: {
      accountCreated: true,
      jobberConnected: company.jobberConnected,
      jobberSkipped: company.jobberSkipped,
      jobberResolved,
      quoConnected: company.quoConnected,
      phoneProvisioned,
      receptionistConfigured: company.receptionistConfigured,
      teamInvited,
      isLive: company.isLive,
      completedSteps: steps.filter(Boolean).length,
      totalSteps: steps.length,
    },
    createdAt: company.createdAt.toISOString(),
  };
}

/**
 * Persist whether Quo currently rejects this company's key. Only writes when
 * the flag actually changes, so hot paths (webhooks, dashboard) don't churn
 * the row on every call.
 *
 * The write is conditional on the row still holding the opposite value, so a
 * healthy → needs-reauth transition is claimed exactly once even when the
 * hourly health check and a webhook race. The same write records that a
 * notification is owed (quoNotifyPending: "dead" or "restored"), and the
 * winning caller immediately attempts to deliver it.
 *
 * The flag itself never reverts because of a notification problem: the
 * dashboard warning flips on the first detection of a dead key and stays put.
 * If the text can't be sent right now, the pending marker survives and the
 * hourly health check (via sendPendingQuoNotification) keeps retrying until
 * it goes out — so the one-per-outage guarantee holds without ever lying
 * about connection health.
 */
export async function setQuoNeedsReauth(
  company: Company,
  needsReauth: boolean,
): Promise<void> {
  if (company.quoNeedsReauth === needsReauth) return;
  const pending = needsReauth ? "dead" : "restored";
  const [claimed] = await db
    .update(companiesTable)
    .set({ quoNeedsReauth: needsReauth, quoNotifyPending: pending })
    .where(
      and(
        eq(companiesTable.id, company.id),
        eq(companiesTable.quoNeedsReauth, !needsReauth),
      ),
    )
    .returning({ id: companiesTable.id });
  company.quoNeedsReauth = needsReauth;
  if (!claimed) return;
  company.quoNotifyPending = pending;
  // Fired only on the claimed transition, so the owner gets one text per
  // outage (and one per recovery), not one per hourly check.
  await sendPendingQuoNotification(company);
}

/**
 * Deliver the owner text recorded in quoNotifyPending, if any.
 *
 * The marker is claimed with a conditional clear before sending, so
 * concurrent retriers (hourly check overlapping a webhook) can't double-text
 * the owner. If the send fails (transient) or is skipped (configuration gap:
 * no platform key, no reachable number), the marker is restored — but only if
 * nothing newer replaced it — so retries continue until the text actually
 * goes out. Skips are also retried: they log a warning each attempt (which
 * surfaces the gap to admins) and succeed automatically once the
 * configuration is fixed.
 */
export async function sendPendingQuoNotification(
  company: Company,
): Promise<void> {
  const pending = company.quoNotifyPending;
  if (pending !== "dead" && pending !== "restored") return;
  const [claimed] = await db
    .update(companiesTable)
    .set({ quoNotifyPending: null })
    .where(
      and(
        eq(companiesTable.id, company.id),
        eq(companiesTable.quoNotifyPending, pending),
      ),
    )
    .returning({ id: companiesTable.id });
  company.quoNotifyPending = null;
  if (!claimed) return;
  const outcome =
    pending === "dead"
      ? await notifyOwnerQuoKeyDead(company)
      : await notifyOwnerQuoRestored(company);
  if (outcome === "sent") return;
  // Not delivered — put the marker back so the next health check retries.
  // Guarded twice: the slot must still be empty (a newer transition's owed
  // text wins) AND the health flag must still match this notification ("dead"
  // only while quoNeedsReauth is true, "restored" only while it's false).
  // Without the flag guard, a stale failed send could re-arm an obsolete text
  // after a newer opposite transition already sent and cleared its own.
  const [restored] = await db
    .update(companiesTable)
    .set({ quoNotifyPending: pending })
    .where(
      and(
        eq(companiesTable.id, company.id),
        isNull(companiesTable.quoNotifyPending),
        eq(companiesTable.quoNeedsReauth, pending === "dead"),
      ),
    )
    .returning({ id: companiesTable.id });
  if (!restored) return;
  company.quoNotifyPending = pending;
  logger.warn(
    { companyId: company.id, pending, outcome },
    "Owner notification not delivered; quoNotifyPending kept so the text is retried on the next health check",
  );
}
