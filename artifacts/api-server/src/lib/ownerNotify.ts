/**
 * Direct owner notifications, sent from the platform's own Quo workspace.
 *
 * These fire when something breaks that the owner would otherwise only
 * discover by opening the dashboard — most importantly a dead Quo key. The
 * company's own key is exactly what stopped working in that case, so the text
 * goes out over the platform's Quo workspace (QUO_API_KEY env secret), never
 * the company's key.
 *
 * All functions here are best-effort: they log failures and never throw, so a
 * notification hiccup can't break the health check or a webhook handler. They
 * do, however, report what happened so callers can react — most importantly
 * sendPendingQuoNotification, which keeps the company's quoNotifyPending
 * marker set when a send fails or is skipped so the text is retried by the
 * hourly health check instead of silently lost.
 */
import type { Company } from "@workspace/db";
import { listPhoneNumbers, sendMessage, toE164 } from "./quo";
import { publicBaseUrl } from "./publicUrl";
import { logger } from "./logger";

/** The platform workspace's key — unrelated to any company's connected key. */
function platformQuoKey(): string | null {
  return process.env.QUO_API_KEY?.trim() || null;
}

/**
 * The platform number notifications are sent from: the first number in the
 * platform's Quo workspace. Cached after the first successful lookup — the
 * workspace's numbers don't churn.
 */
let cachedFromNumber: string | null = null;
async function platformFromNumber(apiKey: string): Promise<string | null> {
  if (cachedFromNumber) return cachedFromNumber;
  const numbers = await listPhoneNumbers(apiKey);
  cachedFromNumber = numbers[0]?.number ?? null;
  return cachedFromNumber;
}

/**
 * What became of a notification attempt:
 * - "sent"    — the text went out.
 * - "skipped" — a configuration gap (no platform key, no ring-through number,
 *               no platform number) made sending impossible. Retrying won't
 *               help until someone fixes the configuration, so callers should
 *               not release claims or retry on this.
 * - "failed"  — the send itself errored (network, Quo 5xx…). Likely
 *               transient; callers may retry.
 */
export type NotifyOutcome = "sent" | "skipped" | "failed";
/** Absolute link to the setup page, valid outside any HTTP request. */
function setupPageUrl(): string {
  const base = process.env.FRONTEND_BASE_PATH || "";
  return `${publicBaseUrl()}${base}/setup`;
}

/**
 * Text the owner (at the company's ring-through number) that their Quo key
 * stopped working, with a link back to setup to reconnect.
 *
 * Callers are responsible for only invoking this on an actual
 * healthy → needs-reauth transition (setQuoNeedsReauth does this via its
 * conditional update), so the owner gets one text per outage, not one per
 * hourly check.
 */
export async function notifyOwnerQuoKeyDead(
  company: Company,
): Promise<NotifyOutcome> {
  return notifyOwner(company, {
    what: "dead Quo key",
    content:
      `Heads up from Book My Cleaning: the Quo connection for ${company.name} stopped working, ` +
      `so calls and texts aren't being handled. Reconnect here: ${setupPageUrl()}`,
    successLog: "Owner notified that their Quo key stopped working",
  });
}

/**
 * Text the owner that their Quo connection is working again, closing the loop
 * opened by notifyOwnerQuoKeyDead.
 *
 * Callers are responsible for only invoking this on an actual
 * needs-reauth → healthy transition (setQuoNeedsReauth does this via its
 * conditional update), so routine healthy → healthy checks stay silent.
 */
export async function notifyOwnerQuoRestored(
  company: Company,
): Promise<NotifyOutcome> {
  return notifyOwner(company, {
    what: "restored Quo connection",
    content:
      `Good news from Book My Cleaning: the Quo connection for ${company.name} is back online. ` +
      `Calls and texts are being handled again — no further action needed.`,
    successLog: "Owner notified that their Quo connection is working again",
  });
}

/** Shared best-effort delivery to the owner over the platform Quo workspace. */
async function notifyOwner(
  company: Company,
  opts: { what: string; content: string; successLog: string },
): Promise<NotifyOutcome> {
  return sendPlatformText(company, { to: null, ...opts });
}

/**
 * The number "text the owner" means for this company: ring-through number
 * first, falling back to the dedicated notification number so owners without
 * a transfer target still hear about things.
 */
export function ownerNumber(company: Company): string | null {
  return (
    (company.ringThroughNumber ? toE164(company.ringThroughNumber) : null) ??
    (company.notificationNumber ? toE164(company.notificationNumber) : null)
  );
}

/**
 * Best-effort text over the platform Quo workspace, to an explicit E.164
 * number or (when `to` is null) to the company's owner. Never throws; the
 * outcome tells callers whether to keep retry state (see NotifyOutcome).
 */
export async function sendPlatformText(
  company: Company,
  opts: {
    to: string | null;
    what: string;
    content: string;
    successLog?: string;
  },
): Promise<NotifyOutcome> {
  try {
    const apiKey = platformQuoKey();
    if (!apiKey) {
      logger.warn(
        { companyId: company.id },
        `Wanted to send a text (${opts.what}) but QUO_API_KEY is not set; not sent`,
      );
      return "skipped";
    }
    const to = opts.to ?? ownerNumber(company);
    if (!to) {
      logger.warn(
        { companyId: company.id },
        `Wanted to send a text (${opts.what}) but there is no usable number to send it to; not sent`,
      );
      return "skipped";
    }
    const from = await platformFromNumber(apiKey);
    if (!from) {
      logger.warn(
        { companyId: company.id },
        `Wanted to send a text (${opts.what}) but the platform Quo workspace has no phone number; not sent`,
      );
      return "skipped";
    }
    await sendMessage(apiKey, { from, to, content: opts.content });
    logger.info(
      { companyId: company.id },
      opts.successLog ?? `Sent text (${opts.what})`,
    );
    return "sent";
  } catch (err) {
    // Best-effort only — never let a notification failure break the caller.
    logger.error(
      { companyId: company.id, err },
      `Failed to send text (${opts.what})`,
    );
    return "failed";
  }
}

/** Absolute link to the app itself, for "sign in here" texts. */
export function appUrl(): string {
  const base = process.env.FRONTEND_BASE_PATH || "";
  return `${publicBaseUrl()}${base}/`;
}

/** Absolute link to the Staff page, valid outside any HTTP request. */
export function staffPageUrl(): string {
  const base = process.env.FRONTEND_BASE_PATH || "";
  return `${publicBaseUrl()}${base}/staff`;
}
