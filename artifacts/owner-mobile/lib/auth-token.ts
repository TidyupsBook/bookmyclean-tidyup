/**
 * Bearer-token plumbing for the phone app.
 *
 * A signed-in phone is often on a flaky connection (basement, elevator, dead
 * spot between jobs). A single failed token refresh must not look like being
 * signed out, so the getter retries once with a forced refresh before giving
 * up, and never throws — a request without a header fails as one request, not
 * as a session ending.
 *
 * A 401 from the API is the mirror problem: the token we sent may have been
 * minted moments before it expired. The retry policy below quietly re-runs
 * the request with a forced-fresh token a bounded number of times before any
 * error surfaces; a genuinely revoked session exhausts those retries quickly
 * (no infinite loop) and Clerk's own signed-out signal takes over.
 */

export type GetTokenLike = (options?: {
  skipCache?: boolean;
}) => Promise<string | null>;

// When set, the next token read skips Clerk's cache. Flipped by the 401
// retry policy so the retried request carries a freshly minted token instead
// of the same expired one out of the cache.
let forceFreshNextToken = false;

/** Make the next token read bypass the cache and mint a fresh token. */
export function requestFreshToken(): void {
  forceFreshNextToken = true;
}

export function createResilientTokenGetter(
  getToken: GetTokenLike,
): () => Promise<string | null> {
  return async () => {
    const forceFresh = forceFreshNextToken;
    forceFreshNextToken = false;
    try {
      const token = await getToken(
        forceFresh ? { skipCache: true } : undefined,
      );
      if (token) return token;
    } catch {
      // Fall through to the forced refresh below.
    }
    if (forceFresh) {
      // We already skipped the cache once; a second identical call won't do
      // better than the first.
      return null;
    }
    try {
      // The cached token may be expired or the cache read may have failed;
      // ask Clerk to mint a fresh one before treating this as unauthenticated.
      return await getToken({ skipCache: true });
    } catch {
      return null;
    }
  };
}

/** True when the error is an API 401 (shape-checked, no client import). */
export function isUnauthorizedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 401
  );
}

/** How many times a 401 is quietly retried before the error surfaces. */
export const MAX_UNAUTHORIZED_RETRIES = 2;

/** Non-auth failures keep react-query's default three attempts. */
const DEFAULT_RETRIES = 3;

/**
 * React-query retry policy for the profile call: a transient 401 (token
 * expired mid-refresh) retries with a forced-fresh token instead of showing
 * the error screen; a persistent 401 stops after a bounded number of tries
 * so a revoked session never spins forever.
 */
export function profileRetryPolicy(
  failureCount: number,
  error: unknown,
): boolean {
  if (isUnauthorizedError(error)) {
    if (failureCount >= MAX_UNAUTHORIZED_RETRIES) return false;
    requestFreshToken();
    return true;
  }
  return failureCount < DEFAULT_RETRIES;
}
