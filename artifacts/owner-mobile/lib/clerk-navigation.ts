/**
 * Clerk can decorate an in-app destination as an absolute URL. On web, keep
 * the decorated path/query/hash but let Expo Router navigate on the origin
 * that is already serving the app. This is especially important in preview,
 * where the Expo host and shared preview host serve different bundles.
 *
 * Native destinations are returned unchanged because custom schemes are
 * meaningful there and there is no browser origin to preserve.
 */
export function clerkAppDestination(
  destination: string,
  browserOrigin?: string,
): string {
  if (!browserOrigin) return destination;

  const url = new URL(destination, browserOrigin);
  return `${url.pathname}${url.search}${url.hash}` || "/";
}
