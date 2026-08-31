import type { Request, Response, NextFunction } from "express";
import { requestHost } from "../lib/requestHost";
import { isSignupHost } from "../lib/signupMode";

/**
 * Redirect browser traffic on any non-canonical host to the pinned domain.
 *
 * The site answers on several hosts at once — the default `.replit.app`
 * domain, the canonical custom domain, and any alias domain pointed at the
 * same deployment. Only one of them should ever appear in a customer's
 * address bar, in shared links, and in search results. This middleware folds
 * every other host into the canonical one with a permanent redirect.
 *
 * Active only when `PUBLIC_APP_URL` is pinned (production sets it; the
 * workspace does not), so development behavior is untouched.
 *
 * Deliberately never redirected:
 * - Webhook receivers and the OAuth callback. A third party calls those on
 *   whatever URL it was registered with, possibly the old host, and some of
 *   those callers (signed webhook POSTs especially) will not follow a
 *   redirect — the event would be silently lost. They must keep answering on
 *   every host.
 * - The health probe. The deployment platform polls it on whatever host it
 *   likes (localhost, the internal port). A 301 there makes the checker
 *   follow the redirect out to the not-yet-healthy public domain and time
 *   out, so the platform restart-loops a perfectly healthy process.
 * - Anything that isn't GET or HEAD. A redirected POST loses its body or its
 *   method depending on the client; only idempotent page loads are safe to
 *   bounce.
 */
export function canonicalHostRedirect(exemptPaths: readonly string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const pinned = process.env.PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
    if (!pinned) {
      next();
      return;
    }

    let canonicalHost: string;
    try {
      canonicalHost = new URL(pinned).host;
    } catch {
      // A malformed pin must not take the whole site down.
      next();
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }

    if (
      exemptPaths.some((p) => req.path === p || req.path.startsWith(`${p}/`))
    ) {
      next();
      return;
    }

    const rawHost = requestHost(req);

    if (!rawHost || rawHost === canonicalHost.toLowerCase()) {
      next();
      return;
    }

    // The designated signup address is deliberately NOT an alias of the
    // canonical site — it is its own front door, where a new owner signs up
    // while the canonical host stays closed. Folding it into the canonical
    // domain would make the second address unreachable.
    if (isSignupHost(rawHost)) {
      next();
      return;
    }

    // Same path and query on the canonical origin. 301 so browsers and
    // crawlers remember that the other hosts are aliases.
    res.redirect(301, `${pinned}${req.originalUrl}`);
  };
}
