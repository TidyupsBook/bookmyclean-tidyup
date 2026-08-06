import type { Request, RequestHandler } from "express";
import { resolveCaller, type Caller, type CallerRole } from "../lib/callerRole";

declare global {
  namespace Express {
    interface Request {
      caller?: Caller;
    }
  }
}

/**
 * Resolve the caller once per request. Handlers and nested middleware share
 * the result rather than each re-querying.
 */
export async function getCaller(req: Request): Promise<Caller> {
  if (!req.caller) {
    req.caller = await resolveCaller(req.userId!);
  }
  return req.caller;
}

/**
 * State which roles a route accepts. Default-deny: a route without this
 * middleware is reachable by any signed-in member of the company, which is
 * only ever correct for things the whole crew may see.
 *
 * Must be mounted after `requireAuth`, and always PER ROUTE — never via
 * `router.use()`. The API's routers are all mounted at `/`, so a request
 * flows through every router until a route matches; a router-level guard
 * therefore runs for OTHER routers' routes too and blocks roles they allow.
 * (This exact bug once made an owner-only router 403 dispatchers and
 * cleaners on every route mounted after it — authorization.test.ts pins the
 * correct behavior.)
 */
export function requireRole(...allowed: CallerRole[]): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      try {
        const caller = await getCaller(req);
        if (!allowed.includes(caller.role)) {
          res
            .status(403)
            .json({ error: "You don't have access to do that here" });
          return;
        }
        next();
      } catch (err) {
        next(err);
      }
    })();
  };
}
