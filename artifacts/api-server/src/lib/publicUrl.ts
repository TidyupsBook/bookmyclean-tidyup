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

/**
 * Whether a webhook registration at `hookUrl` belongs to THIS environment,
 * and is therefore safe to delete when superseding it.
 *
 * The dev and published copies of this app share one Quo account, and a
 * freshly provisioned database carries the other environment's webhook rows.
 * Deleting "our previous hooks" by id then severs the other environment's
 * live ingestion — production boots and kills dev's hooks, dev re-picks and
 * kills production's. Ownership is decided by URL host instead: an
 * environment only ever deletes registrations pointing at hosts it answers
 * for. A live dev workspace host (*.replit.dev) is never the published
 * site's to delete, and a pinned/custom domain is never the workspace's.
 * Rows for foreign hooks may still be dropped from the local table — the
 * registration itself must stay alive on Quo's side.
 */
export function ownsWebhookHost(hookUrl: string): boolean {
  let host: string;
  try {
    host = new URL(hookUrl).host;
  } catch {
    return false;
  }
  if (host === new URL(publicBaseUrl()).host) return true;
  // A pinned environment (the published site) also owns any earlier
  // registration it made under previous deploy domains — but a live dev
  // workspace's registration is never its to remove.
  const pinned = Boolean(process.env.PUBLIC_APP_URL?.trim());
  return pinned && !host.endsWith(".replit.dev");
}

/**
 * Where Stripe's managed webhook should deliver, or null when no public host
 * exists at all.
 *
 * The canonical pin (PUBLIC_APP_URL, production-only) wins so Stripe delivers
 * to the official domain rather than an alias host. Without a pin this stays
 * self-inferring: in the workspace REPLIT_DOMAINS is the dev domain, so
 * development keeps registering a webhook pointing at itself.
 */
export function stripeWebhookUrl(path: string): string | null {
  const pinned = process.env.PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  const host = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  const base = pinned || (host ? `https://${host}` : null);
  return base ? `${base}${path}` : null;
}
