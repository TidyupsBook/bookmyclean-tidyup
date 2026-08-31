/**
 * A small in-process rate limiter for endpoints that spend money per call.
 *
 * This is a cost guard, not a security boundary: it lives in one process, so a
 * multi-instance deployment enforces it per instance and a restart forgets
 * everything. That is deliberate — the thing being defended against is a loop
 * (a stuck retry, a script, one signed-in person holding a key down) running up
 * a Google bill, and for that a cheap local ceiling is enough. Anything that
 * genuinely needs a hard, shared quota belongs in the database.
 */

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

/**
 * Drop windows that expired a while ago, so a long-running server doesn't hold
 * a row for every user who ever called. Run on write, which is the only time
 * the map grows.
 */
function prune(now: number): void {
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}

/**
 * Count one request against `key`, and say whether it is allowed.
 *
 * A fixed window rather than a sliding one: a caller can send up to twice the
 * limit across a window boundary, which does not matter for a spend ceiling and
 * keeps this to one map entry per caller.
 */
export function allowRequest(
  key: string,
  options: { limit: number; windowMs: number },
  now: number = Date.now(),
): boolean {
  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    if (windows.size > 500) prune(now);
    windows.set(key, { count: 1, resetAt: now + options.windowMs });
    return true;
  }
  if (existing.count >= options.limit) return false;
  existing.count += 1;
  return true;
}

/** Forget every window. Tests only — the real one ages out on its own. */
export function resetRateLimits(): void {
  windows.clear();
}
