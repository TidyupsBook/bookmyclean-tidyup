import type { Request } from "express";

/**
 * The host the visitor actually typed, lowercased, without port games.
 *
 * Behind the deployment proxy the original host arrives in X-Forwarded-Host;
 * direct requests carry it in Host. Several parts of the app care which
 * address a request came in on — the canonical-host redirect and the
 * signup-host door — and they must agree on how the host is read, or a
 * request could dodge the redirect on one reading and be refused signup on
 * the other.
 */
export function requestHost(req: Request): string {
  const forwarded = req.headers["x-forwarded-host"];
  return (
    (Array.isArray(forwarded) ? forwarded[0] : forwarded) ??
    req.headers.host ??
    ""
  )
    .split(",")[0]!
    .trim()
    .toLowerCase();
}
