/**
 * The externally reachable base URL for this server.
 *
 * `PUBLIC_APP_URL` wins when set. Everything else here is inferred from
 * whichever domain the process happens to be running on, which is fine for a
 * webhook we register ourselves and wrong for anything a third party has to be
 * told in advance. An OAuth redirect URI is the clear case: it has to be
 * approved once, by hand, in the other service's settings, and it has to match
 * on every subsequent authorization. Inferred hosts differ between the
 * workspace and the published site, and a custom domain does not necessarily
 * come first in REPLIT_DOMAINS — so without a pin, the URL shown to the owner
 * is whichever environment they happened to open, and approving it there does
 * not make it work anywhere else.
 *
 * Quo requires an HTTPS URL it can reach, so localhost is never valid here.
 */
export function publicBaseUrl(): string {
  const pinned = process.env.PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  if (pinned) return pinned;

  const domains = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  const dev = process.env.REPLIT_DEV_DOMAIN?.trim();
  const host = domains || dev;
  if (!host) {
    throw new Error("No public domain available for webhook registration");
  }
  return `https://${host}`;
}

/**
 * Where Jobber sends the owner back after they authorize us.
 *
 * Surfaced to the dashboard so the owner can copy the exact string into their
 * Jobber app rather than guessing at it — guessing produces a domain that
 * looks plausible and fails at the last step of every connection attempt.
 */
export function jobberRedirectUri(): string {
  return `${publicBaseUrl()}/api/company/jobber/callback`;
}

export function publicWebhookUrl(): string {
  return `${publicBaseUrl()}/api/webhooks/quo`;
}
