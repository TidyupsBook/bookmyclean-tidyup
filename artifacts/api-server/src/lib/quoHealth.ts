/**
 * Periodic Quo key health check.
 *
 * The quoNeedsReauth flag is normally only updated when something actively
 * hits Quo (webhooks, dashboard loads, manual syncs). If a key is revoked
 * during a quiet period, nothing notices until a customer call goes
 * unanswered. This check proactively verifies each connected company's key on
 * an interval so the dashboard warning flips without waiting for traffic.
 */
import { isNotNull, and, eq } from "drizzle-orm";
import { db, companiesTable } from "@workspace/db";
import { listPhoneNumbers } from "./quo";
import {
  companyQuoKey,
  isQuoAuthError,
  sendPendingQuoNotification,
  setQuoNeedsReauth,
} from "./company";
import { logger } from "./logger";

/** One hour: frequent enough to catch a dead key, gentle on Quo's API. */
export const QUO_HEALTH_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Verify every connected company's Quo key with a single lightweight
 * listPhoneNumbers call each. 401/403 marks the company as needing reauth;
 * success clears the flag. Other errors (network, 5xx) change nothing — an
 * outage on Quo's side does not mean the key is dead.
 */
export async function runQuoHealthCheck(): Promise<void> {
  const companies = await db
    .select()
    .from(companiesTable)
    .where(
      and(
        eq(companiesTable.quoConnected, true),
        isNotNull(companiesTable.quoApiKeyEncrypted),
      ),
    );

  for (const company of companies) {
    const key = companyQuoKey(company);
    if (!key) {
      // Key present but no longer decryptable — the owner must reconnect.
      await setQuoNeedsReauth(company, true);
      // Fall through to the pending-notification retry below.
    } else {
      try {
        await listPhoneNumbers(key);
        await setQuoNeedsReauth(company, false);
      } catch (err) {
        if (isQuoAuthError(err)) {
          await setQuoNeedsReauth(company, true);
          logger.warn(
            { companyId: company.id },
            "Quo health check: key rejected; company flagged for reauth",
          );
        } else {
          // Transient failure — leave the flag as-is.
          logger.warn(
            { companyId: company.id, err },
            "Quo health check: Quo unreachable; flag left unchanged",
          );
        }
      }
    }
    // Retry any owner text still owed from an earlier transition whose send
    // failed or was skipped. No-op when nothing is pending.
    await sendPendingQuoNotification(company);
  }
}

let timer: NodeJS.Timeout | null = null;

/**
 * Start the hourly check. Runs once shortly after boot (delayed so startup
 * traffic and migrations settle first), then on the interval.
 */
export function startQuoHealthCheck(): void {
  if (timer) return;
  const run = () => {
    runQuoHealthCheck().catch((err) =>
      logger.error({ err }, "Quo health check run failed"),
    );
  };
  // First pass a minute after boot, then hourly.
  setTimeout(run, 60 * 1000).unref();
  timer = setInterval(run, QUO_HEALTH_CHECK_INTERVAL_MS);
  timer.unref();
}
