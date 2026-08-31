/**
 * Whether this deployment is still handing out new companies.
 *
 * The same codebase runs more than one storefront. bookmycleaning.net is a
 * single company's live site — Tidyups' own — and nobody should be able to
 * land on it and start a rival workspace inside it. Other domains are where
 * new owners sign up, and they run the same build with this left open.
 *
 * Deliberately a runtime setting rather than a code branch: closing the door
 * is a property of the address it's served at, not of the software, and a
 * second deployment must not need a second version of the app.
 *
 * Staff signup is untouched either way. Crew still create a login and join
 * with the company's code — that's how a cleaner gets a phone in the first
 * place. This closes exactly one thing: creating a brand new company.
 */
export type SignupMode = "open" | "closed";

/** Anything other than an explicit "closed" leaves the door open. */
export function newCompanySignups(
  env: NodeJS.ProcessEnv = process.env,
): SignupMode {
  return env.NEW_COMPANY_SIGNUPS?.trim().toLowerCase() === "closed"
    ? "closed"
    : "open";
}

export function newCompaniesAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return newCompanySignups(env) === "open";
}

/**
 * The addresses on this deployment where new companies may still sign up,
 * even while the rest of the site is closed.
 *
 * A Replit project carries exactly one published deployment, so "a second
 * address with signups open" cannot be a second copy of the app — it is a
 * second domain pointed at the same deployment. Without this, that alias is
 * useless twice over: the canonical-host middleware bounces every page load
 * back to bookmycleaning.net, and the closed flag refuses the signup anyway.
 * `SIGNUP_HOST` names the alias (or aliases, comma separated) that get to
 * keep their own front door.
 *
 * Accepts a bare host ("signup.example.com") or a full URL and normalizes to
 * the lowercase host, so a value pasted with "https://" still matches.
 *
 * A domain and its `www.` sibling are the same front door. Both forms are
 * usually linked in Publishing, and a visitor who types the one that wasn't
 * named would otherwise be bounced to the closed canonical site — which
 * reads as "my new domain sends people to the old one".
 *
 * The canonical site can never be a signup door, however it is spelled —
 * bare, `www.`, or with an explicit `:443`. A mistyped value must not quietly
 * reopen the site that is meant to be shut, and since the two spellings are
 * the same door everywhere else here, naming one of them names both.
 */
export function signupHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.SIGNUP_HOST?.trim();
  if (!raw) return [];

  const doors = new Set<string>();
  for (const entry of raw.split(",")) {
    const host = normalizeHost(entry);
    if (host) for (const form of hostAndSibling(host)) doors.add(form);
  }

  const canonical = normalizeHost(env.PUBLIC_APP_URL);
  if (canonical)
    for (const form of hostAndSibling(canonical)) doors.delete(form);

  return [...doors];
}

/**
 * A host as this app compares them: lowercase, no scheme, no path, and no
 * redundant default port.
 *
 * The port matters: `PUBLIC_APP_URL` is parsed by `URL`, which drops `:443`,
 * so a configured value that keeps it would otherwise look like a different
 * host than the canonical one and slip past the exclusion below.
 */
function normalizeHost(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const host = raw
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/:(?:80|443)$/, "")
    .trim()
    .toLowerCase();
  return host || null;
}

/** A host together with its `www.` sibling — one address, two spellings. */
function hostAndSibling(host: string): [string, string] {
  return [host, host.startsWith("www.") ? host.slice(4) : `www.${host}`];
}

/**
 * Whether this is one of the addresses that keeps its own front door.
 *
 * The host comes from the request, which means it is ultimately something a
 * caller can claim. That is acceptable here and nowhere else: the worst a
 * forged header buys is a brand new empty company of one's own — exactly what
 * the open address hands out to anyone who asks. It grants no access to any
 * existing company's data, so this door is a matter of which address shows
 * which front page, never an authorization check.
 */
export function isSignupHost(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const asked = normalizeHost(host);
  if (!asked) return false;
  return signupHosts(env).includes(asked);
}

/**
 * Whether the address a request arrived on hands out new companies.
 *
 * Open everywhere when the deployment-wide flag is open; on a closed
 * deployment, open only on the designated signup host. An empty host (no
 * Host header at all) never matches — "still loading / unknown" is closed.
 */
export function newCompaniesAllowedForHost(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (newCompaniesAllowed(env)) return true;
  return isSignupHost(host, env);
}
