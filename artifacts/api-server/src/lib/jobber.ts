import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  companiesTable,
  jobberConnectionsTable,
  type Company,
  type JobberConnection,
} from "@workspace/db";
import { logger } from "./logger";
import { encryptJobberToken, decryptJobberToken } from "./secretBox";

const JOBBER_AUTHORIZE_URL = "https://api.getjobber.com/api/oauth/authorize";
const JOBBER_TOKEN_URL = "https://api.getjobber.com/api/oauth/token";
const JOBBER_GRAPHQL_URL = "https://api.getjobber.com/api/graphql";
const JOBBER_GRAPHQL_VERSION = "2025-04-16";
/** Generous — the calendar pull asks for large pages — but not unbounded. */
const JOBBER_REQUEST_TIMEOUT_MS = 45_000;

export function getJobberCredentials(): {
  clientId: string;
  clientSecret: string;
} | null {
  const clientId = process.env["JOBBER_CLIENT_ID"];
  const clientSecret = process.env["JOBBER_CLIENT_SECRET"];
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(JOBBER_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("state", args.state);
  url.searchParams.set("code_challenge", args.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
};

export class JobberTokenError extends Error {
  constructor(
    message: string,
    /** True when the grant itself was rejected (revoked/expired), not a transient failure. */
    public readonly grantRejected: boolean,
  ) {
    super(message);
    this.name = "JobberTokenError";
  }
}

async function requestToken(
  params: Record<string, string>,
): Promise<TokenResponse> {
  const res = await fetch(JOBBER_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    // 400/401 means the grant is dead (revoked, expired, or already rotated),
    // not a transient outage — the only fix is re-authorizing.
    throw new JobberTokenError(
      `Jobber token endpoint returned ${res.status}: ${text}`,
      res.status === 400 || res.status === 401,
    );
  }
  return JSON.parse(text) as TokenResponse;
}

/**
 * Translate a token-exchange failure into a message an owner can act on.
 * Jobber's error bodies are plain text and distinguish the common causes.
 */
export function friendlyTokenExchangeError(err: unknown): string {
  if (err instanceof JobberTokenError) {
    const body = err.message.toLowerCase();
    if (body.includes("client id and secret do not match")) {
      return "Jobber rejected this app's credentials. The Jobber client ID and secret configured on the server don't match a Jobber app — check JOBBER_CLIENT_ID and JOBBER_CLIENT_SECRET.";
    }
    if (
      body.includes("redirect uri") ||
      body.includes("redirect_uri") ||
      body.includes("authorization code was not valid") ||
      body.includes("invalid_grant")
    ) {
      return "Jobber rejected the sign-in handoff. This usually means the callback URL registered in the Jobber app doesn't exactly match this site's callback URL, or the approval expired — check the Jobber Developer Center callback URL and try connecting again.";
    }
    return "Jobber refused to complete the connection. Please try connecting again.";
  }
  return "Could not complete the Jobber connection. Please try again.";
}

export async function exchangeAuthorizationCode(args: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenResponse> {
  const creds = getJobberCredentials();
  if (!creds) throw new Error("Jobber API credentials are not configured");
  return requestToken({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    code_verifier: args.codeVerifier,
  });
}

async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  const creds = getJobberCredentials();
  if (!creds) throw new Error("Jobber API credentials are not configured");
  return requestToken({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

export function tokenExpiry(expiresInSeconds: number | undefined): Date {
  return new Date(Date.now() + (expiresInSeconds ?? 3600) * 1000);
}

/**
 * Which copy of the app this process is — the published site pins
 * PUBLIC_APP_URL; anything without a pin is the dev workspace.
 *
 * Named in errors and logs because dev and production share one Jobber
 * account while Jobber rotates the refresh token on every renewal: whichever
 * environment refreshes second holds a stale token and gets rejected. When
 * that happens, the owner needs to know *which* copy lost its grant — the
 * other one is usually still connected and fine.
 */
export function jobberEnvironmentLabel(): string {
  return isPinnedEnvironment() ? "the published site" : "the dev workspace";
}

/** True when this process is the published site (PUBLIC_APP_URL is pinned). */
export function isPinnedEnvironment(): boolean {
  return Boolean(process.env["PUBLIC_APP_URL"]?.trim());
}

/**
 * Returns a valid access token for the company, refreshing (and persisting the
 * rotated refresh token) when the stored token is expired or about to expire.
 */
export async function getValidAccessToken(company: Company): Promise<string> {
  if (!company.jobberRefreshToken || !company.jobberAccessToken) {
    await db
      .update(companiesTable)
      .set({ jobberNeedsReauth: true })
      .where(eq(companiesTable.id, company.id));
    throw new Error("Jobber is not connected for this company");
  }
  const accessToken = decryptJobberToken(company.jobberAccessToken);
  if (!accessToken) {
    await db
      .update(companiesTable)
      .set({ jobberNeedsReauth: true })
      .where(eq(companiesTable.id, company.id));
    throw new Error(
      "Jobber access token could not be decrypted — reconnect Jobber",
    );
  }
  const refreshToken = decryptJobberToken(company.jobberRefreshToken);
  if (!refreshToken) {
    await db
      .update(companiesTable)
      .set({ jobberNeedsReauth: true })
      .where(eq(companiesTable.id, company.id));
    throw new Error(
      "Jobber refresh token could not be decrypted — reconnect Jobber",
    );
  }

  const expiresAt = company.jobberTokenExpiresAt?.getTime() ?? 0;
  const stillValid = expiresAt - Date.now() > 60_000;
  if (stillValid) return accessToken;

  let tokens: TokenResponse;
  try {
    tokens = await refreshTokens(refreshToken);
  } catch (err) {
    if (err instanceof JobberTokenError && err.grantRejected) {
      // The tokens THIS environment holds are known-dead. Flag the company so
      // the UI switches from "Sync" to "Reconnect Jobber" instead of failing
      // on every attempt. Name the environment in both the log and the error:
      // when dev and production share one Jobber account, a rejection here
      // usually means the *other* environment refreshed first and rotated the
      // token away — the other copy is still connected, and only this one
      // needs reconnecting.
      const environment = jobberEnvironmentLabel();
      await db
        .update(companiesTable)
        .set({ jobberNeedsReauth: true })
        .where(eq(companiesTable.id, company.id));
      logger.warn(
        { companyId: company.id, environment },
        "Jobber refresh token rejected; company flagged for reconnect in this environment (if dev and production share this Jobber account, the other environment likely rotated the token and is still connected)",
      );
      throw new Error(
        `Jobber authorization has expired in ${environment} — reconnect Jobber here to keep syncing. If the other environment shares this Jobber account, it likely rotated the token and is still connected.`,
      );
    }
    throw err;
  }
  await db
    .update(companiesTable)
    .set({
      jobberAccessToken: encryptJobberToken(tokens.access_token),
      jobberRefreshToken: encryptJobberToken(
        tokens.refresh_token || refreshToken,
      ),
      jobberTokenExpiresAt: tokenExpiry(tokens.expires_in),
      // The grant just proved it works, so the flag comes off. Leaving it set
      // is what kept an account that had recovered on its own stuck behind
      // "reconnect Jobber" — with every push skipped in silence.
      jobberNeedsReauth: false,
    })
    .where(eq(companiesTable.id, company.id));
  return tokens.access_token;
}

/**
 * Returns a valid access token for a specific Jobber connection row, refreshing
 * (and persisting the rotated refresh token) when the stored token is expired
 * or about to expire. Mirrors getValidAccessToken but operates on the
 * jobber_connections table so multiple connections per company each maintain
 * their own token lifecycle.
 */
export async function getValidConnectionToken(
  connection: JobberConnection,
): Promise<string> {
  const flagNeedsReauth = async () => {
    await db
      .update(jobberConnectionsTable)
      .set({ needsReauth: true })
      .where(eq(jobberConnectionsTable.id, connection.id));
  };

  if (!connection.refreshToken || !connection.accessToken) {
    await flagNeedsReauth();
    throw new Error("Jobber connection is not authenticated");
  }
  const accessToken = decryptJobberToken(connection.accessToken);
  if (!accessToken) {
    await flagNeedsReauth();
    throw new Error(
      "Jobber access token could not be decrypted — reconnect Jobber",
    );
  }
  const refreshToken = decryptJobberToken(connection.refreshToken);
  if (!refreshToken) {
    await flagNeedsReauth();
    throw new Error(
      "Jobber refresh token could not be decrypted — reconnect Jobber",
    );
  }

  const expiresAt = connection.tokenExpiresAt?.getTime() ?? 0;
  const stillValid = expiresAt - Date.now() > 60_000;
  if (stillValid) return accessToken;

  let tokens: TokenResponse;
  try {
    tokens = await refreshTokens(refreshToken);
  } catch (err) {
    if (err instanceof JobberTokenError && err.grantRejected) {
      const environment = jobberEnvironmentLabel();
      await flagNeedsReauth();
      logger.warn(
        {
          connectionId: connection.id,
          companyId: connection.companyId,
          environment,
        },
        "Jobber connection refresh token rejected; connection flagged for reconnect",
      );
      throw new Error(
        `Jobber authorization has expired in ${environment} — reconnect this Jobber account to keep syncing.`,
      );
    }
    throw err;
  }
  const encryptedAccess = encryptJobberToken(tokens.access_token);
  const encryptedRefresh = encryptJobberToken(
    tokens.refresh_token || refreshToken,
  );
  const expiresAtNext = tokenExpiry(tokens.expires_in);
  await db.transaction(async (tx) => {
    await tx
      .update(jobberConnectionsTable)
      .set({
        accessToken: encryptedAccess,
        refreshToken: encryptedRefresh,
        tokenExpiresAt: expiresAtNext,
        needsReauth: false,
      })
      .where(eq(jobberConnectionsTable.id, connection.id));

    // Several established Jobber services still use the company's primary
    // credential mirror. A rotated primary refresh token must update it in the
    // same transaction, or their next call would poison a healthy company with
    // a false "reconnect" state.
    if (connection.isPrimary) {
      await tx
        .update(companiesTable)
        .set({
          jobberAccessToken: encryptedAccess,
          jobberRefreshToken: encryptedRefresh,
          jobberTokenExpiresAt: expiresAtNext,
          jobberNeedsReauth: false,
        })
        .where(eq(companiesTable.id, connection.companyId));
    }
  });
  return tokens.access_token;
}

type GraphQLResult<T> = { data?: T; errors?: Array<{ message: string }> };

export async function jobberGraphql<T>(
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(JOBBER_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-JOBBER-GRAPHQL-VERSION": JOBBER_GRAPHQL_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    // A call that never answers must not hang forever: outbound pushes run one
    // at a time per company, so one stuck request would stall every booking
    // behind it.
    signal: AbortSignal.timeout(JOBBER_REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Jobber API returned ${res.status}: ${text.slice(0, 500)}`);
  }
  const body = JSON.parse(text) as GraphQLResult<T>;
  if (body.errors?.length) {
    throw new Error(
      `Jobber API error: ${body.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (!body.data) throw new Error("Jobber API returned no data");
  return body.data;
}

export async function fetchJobberAccount(
  accessToken: string,
): Promise<{ id: string; name: string }> {
  const data = await jobberGraphql<{ account: { id: string; name: string } }>(
    accessToken,
    `query { account { id name } }`,
  );
  return data.account;
}

const BOOK_MY_CLEANING_TAX_RATE = 12.5;

export class JobberTaxConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobberTaxConfigurationError";
  }
}

/**
 * Invoices intentionally contain no local tax line. Verify the connected
 * account has exactly the one tax rate that the customer-facing quote uses
 * before creating an invoice, rather than allowing a zero, different, or
 * ambiguous Jobber configuration to silently change the amount due.
 */
export async function verifyJobberTaxConfiguration(
  accessToken: string,
): Promise<void> {
  const data = await jobberGraphql<{
    account: { taxRates: { nodes: Array<{ rate: number | string | null }> } };
  }>(
    accessToken,
    `query JobberTaxConfiguration {
      account {
        taxRates(first: 50) { nodes { rate } }
      }
    }`,
  );
  const rates = data.account.taxRates.nodes
    .map((tax) => (typeof tax.rate === "string" ? Number(tax.rate) : tax.rate))
    .filter(
      (rate): rate is number =>
        typeof rate === "number" && Number.isFinite(rate),
    );
  if (
    rates.length !== 1 ||
    Math.abs(rates[0]! - BOOK_MY_CLEANING_TAX_RATE) > 0.0001
  ) {
    const configured = rates.length > 0 ? rates.join(", ") : "none";
    throw new JobberTaxConfigurationError(
      `Jobber tax configuration must contain exactly one rate of ${BOOK_MY_CLEANING_TAX_RATE}%; found ${configured}. Update Jobber's tax settings before creating invoices.`,
    );
  }
}

export async function disconnectJobberApp(accessToken: string): Promise<void> {
  await jobberGraphql(
    accessToken,
    `mutation { appDisconnect { userErrors { message } } }`,
  );
}

/**
 * Everything the Leads inbox needs to show one Jobber work request. The
 * webhook event carries only ids, so the details are read back with one
 * lean query — the account's rate budget is shared across environments and
 * pollers, so this asks for exactly the fields a lead card shows and only
 * the first few notes (the customer's own message from the request form
 * arrives as the request's first note).
 */
export type JobberRequestDetails = {
  id: string;
  title: string | null;
  requestStatus: string | null;
  createdAt: string | null;
  jobberWebUri: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  client: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
  } | null;
  property: {
    id: string;
    address: {
      street: string | null;
      city: string | null;
      province: string | null;
      postalCode: string | null;
    } | null;
  } | null;
  notes: {
    nodes: Array<{ message?: string | null } | null>;
  } | null;
};

export async function fetchJobberRequestDetails(
  accessToken: string,
  requestId: string,
): Promise<JobberRequestDetails | null> {
  const data = await jobberGraphql<{ request: JobberRequestDetails | null }>(
    accessToken,
    `query LeadRequestDetails($id: EncodedId!) {
      request(id: $id) {
        id
        title
        requestStatus
        createdAt
        jobberWebUri
        contactName
        phone
        email
        client { id firstName lastName phone }
        property { id address { street city province postalCode } }
        notes(first: 3) { nodes { ... on RequestNote { message } } }
      }
    }`,
    { id: requestId },
  );
  return data.request ?? null;
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0]!, lastName: "" };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1]!,
  };
}

type UserError = { message: string; path?: string[] };

function assertNoUserErrors(operation: string, userErrors: UserError[]): void {
  if (userErrors.length) {
    throw new Error(
      `Jobber ${operation} rejected: ${userErrors.map((e) => e.message).join("; ")}`,
    );
  }
}

/**
 * A service address as Jobber wants it: separate parts, not one line. The
 * booking desk already keeps them apart, and Jobber can only place a pin on
 * the map when it gets them apart.
 */
export type JobberAddress = {
  street1: string | null;
  street2: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
};

export type JobberProperty = {
  id: string;
  street1: string | null;
  street2: string | null;
  city: string | null;
  postalCode: string | null;
};

export function hasAnyAddress(address: JobberAddress): boolean {
  return Boolean(address.street1 || address.city || address.postalCode);
}

function addressAttributes(
  address: JobberAddress,
  options: { includeClearedStreet2?: boolean } = {},
): Record<string, string | null> {
  const attrs: Record<string, string | null> = {};
  if (address.street1) attrs["street1"] = address.street1;
  if (address.street2) {
    attrs["street2"] = address.street2;
  } else if (options.includeClearedStreet2) {
    // Omitting a field from propertyEdit preserves its old remote value. A
    // deliberate null is what removes a suite/unit that was cleared here.
    attrs["street2"] = null;
  }
  if (address.city) attrs["city"] = address.city;
  if (address.province) attrs["province"] = address.province;
  if (address.postalCode) attrs["postalCode"] = address.postalCode;
  return attrs;
}

/** Last ten digits, so "(780) 555-0101" and "+17805550101" compare equal. */
function phoneKey(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

function addressKey(
  street1: string | null | undefined,
  street2: string | null | undefined,
): string {
  return [street1, street2]
    .map((part) => (part ?? "").trim().toLowerCase().replace(/\s+/g, " "))
    .filter(Boolean)
    .join(", ");
}

// `number` and `friendly`, never `raw`: Jobber's ClientPhoneNumber has no
// such field, and asking for it fails the whole query — which is exactly how
// every outbound push for a live account died at its first step, long before
// it ever reached a mutation.
const CLIENT_PROPERTY_FIELDS = `
  id
  name
  phones { number friendly }
  clientProperties(first: 20) {
    nodes { id address { street1 street2 city postalCode } }
  }
`;

type JobberClientNode = {
  id: string;
  name: string;
  phones: Array<{
    id?: string;
    number: string | null;
    friendly: string | null;
    primary?: boolean;
  }>;
  clientProperties: {
    nodes: Array<{
      id: string;
      address: {
        street1: string | null;
        street2: string | null;
        city: string | null;
        postalCode: string | null;
      } | null;
    }>;
  };
};

function toClient(node: JobberClientNode): {
  id: string;
  properties: JobberProperty[];
} {
  return {
    id: node.id,
    properties: node.clientProperties.nodes.map((p) => ({
      id: p.id,
      street1: p.address?.street1 ?? null,
      street2: p.address?.street2 ?? null,
      city: p.address?.city ?? null,
      postalCode: p.address?.postalCode ?? null,
    })),
  };
}

/**
 * Look for a customer Jobber already knows, matched on phone number.
 *
 * Without this every booking minted a second Jobber client, so a regular
 * customer would fan out into one client per clean. Jobber's search is fuzzy,
 * so the digits are compared here rather than trusting whatever came back.
 */
export async function findJobberClient(
  accessToken: string,
  phone: string,
): Promise<{ id: string; properties: JobberProperty[] } | null> {
  const wanted = phoneKey(phone);
  if (wanted.length < 7) return null;
  const data = await jobberGraphql<{
    clients: { nodes: JobberClientNode[] };
  }>(
    accessToken,
    `query FindClient($term: String!) {
      clients(searchTerm: $term, searchFields: [PHONES], first: 10) {
        nodes { ${CLIENT_PROPERTY_FIELDS} }
      }
    }`,
    { term: phone },
  );
  const match = data.clients.nodes.find((node) =>
    node.phones.some(
      (p) =>
        phoneKey(p.number ?? "") === wanted ||
        phoneKey(p.friendly ?? "") === wanted,
    ),
  );
  return match ? toClient(match) : null;
}

type OrphanClientNode = JobberClientNode & {
  emails: Array<{ address: string | null }>;
  requests: { nodes: Array<{ id: string }> };
};

const ORPHAN_CLIENT_SELECTION = `
  id
  name
  emails { address }
  phones { number friendly }
  requests(first: 1) { nodes { id } }
  clientProperties(first: 20) {
    nodes { id address { street1 street2 city postalCode } }
  }
`;

/**
 * Find the client an earlier, interrupted push attempt created for a website
 * lead: the crash window where Jobber accepted clientCreate but the id was
 * never written down leaves an orphan we would otherwise re-create.
 *
 * This is NOT the forbidden phone-match. Only an exact double of what our
 * own push would have made qualifies: the same name, exactly the phone and
 * email we would have sent (absent means absent on both sides), and NO
 * requests on it. An established customer has history; a client that is a
 * byte-for-byte copy of this lead with nothing on it is ours.
 */
export async function findLeadOrphanClient(
  accessToken: string,
  args: { name: string; phone: string; email: string | null },
): Promise<{ id: string; properties: JobberProperty[] } | null> {
  const nameKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const phoneWanted = phoneKey(args.phone);
  // Phone search when the number is searchable; otherwise the name — either
  // way the strict field-for-field match below decides, never the search.
  const byPhone = phoneWanted.length >= 7;
  const data = await jobberGraphql<{
    clients: { nodes: OrphanClientNode[] };
  }>(
    accessToken,
    byPhone
      ? `query LeadOrphanClient($term: String!) {
          clients(searchTerm: $term, searchFields: [PHONES], first: 10) {
            nodes { ${ORPHAN_CLIENT_SELECTION} }
          }
        }`
      : `query LeadOrphanClient($term: String!) {
          clients(searchTerm: $term, first: 10) {
            nodes { ${ORPHAN_CLIENT_SELECTION} }
          }
        }`,
    { term: byPhone ? args.phone : args.name },
  );
  const wantedName = nameKey(args.name);
  const wantedEmail = args.email?.trim().toLowerCase() || null;
  const match = data.clients.nodes.find((node) => {
    if (nameKey(node.name ?? "") !== wantedName) return false;
    // Any request at all means a real customer relationship — not ours.
    if ((node.requests?.nodes ?? []).length > 0) return false;
    const phones = node.phones ?? [];
    if (args.phone.trim()) {
      const hit = phones.some(
        (p) =>
          phoneKey(p.number ?? "") === phoneWanted ||
          phoneKey(p.friendly ?? "") === phoneWanted,
      );
      if (!hit) return false;
    } else if (phones.length > 0) {
      return false;
    }
    const emails = (node.emails ?? [])
      .map((e) => (e.address ?? "").trim().toLowerCase())
      .filter(Boolean);
    if (wantedEmail) {
      if (!emails.includes(wantedEmail)) return false;
    } else if (emails.length > 0) {
      return false;
    }
    return true;
  });
  return match ? toClient(match) : null;
}

export async function createJobberClient(
  accessToken: string,
  args: {
    name: string;
    phone: string;
    email: string | null;
    address: JobberAddress;
  },
): Promise<{ id: string; properties: JobberProperty[] }> {
  const { firstName, lastName } = splitName(args.name);
  const input: Record<string, unknown> = { firstName, lastName };
  // A booking taken mid-call may not have a number yet. Sending an empty one
  // is worse than sending none: Jobber rejects the blank string and the whole
  // sync fails, where a name-only client goes through and can be filled in
  // later from either side.
  if (args.phone.trim()) {
    input["phones"] = [
      { description: "MAIN", primary: true, number: args.phone },
    ];
  }
  if (args.email) {
    input["emails"] = [
      { description: "MAIN", primary: true, address: args.email },
    ];
  }
  // The address goes on as a property at creation time. A Jobber client with
  // no property can be quoted but not scheduled, and a request without one
  // lands with no address on it at all.
  if (hasAnyAddress(args.address)) {
    input["properties"] = [{ address: addressAttributes(args.address) }];
  }
  const data = await jobberGraphql<{
    clientCreate: {
      client: JobberClientNode | null;
      userErrors: UserError[];
    };
  }>(
    accessToken,
    `mutation CreateClient($input: ClientCreateInput!) {
      clientCreate(input: $input) {
        client { ${CLIENT_PROPERTY_FIELDS} }
        userErrors { message path }
      }
    }`,
    { input },
  );
  assertNoUserErrors("clientCreate", data.clientCreate.userErrors);
  if (!data.clientCreate.client) {
    throw new Error("Jobber clientCreate returned no client");
  }
  return toClient(data.clientCreate.client);
}

/**
 * Keep the name and primary phone on an already-linked Jobber client aligned
 * with the booking.
 *
 * Jobber edits phone rows by id, so the current primary phone is read first.
 * Other phone rows are left alone: they may be legitimate alternate numbers
 * that were added in Jobber and Book My Cleaning does not own them.
 */
export async function updateJobberClient(
  accessToken: string,
  args: { clientId: string; name: string; phone: string },
): Promise<void> {
  const current = await jobberGraphql<{
    client: {
      id: string;
      phones: Array<{
        id: string;
        number: string;
        friendly: string;
        primary: boolean;
      }>;
    } | null;
  }>(
    accessToken,
    `query ClientForContactEdit($clientId: EncodedId!) {
      client(id: $clientId) {
        id
        phones { id number friendly primary }
      }
    }`,
    { clientId: args.clientId },
  );
  if (!current.client) {
    throw new Error("Jobber client was not found");
  }

  const { firstName, lastName } = splitName(args.name);
  const input: Record<string, unknown> = { firstName, lastName };
  const phone = args.phone.trim();
  const existingPhone =
    current.client.phones.find((candidate) => candidate.primary) ??
    current.client.phones[0];

  if (phone) {
    if (existingPhone) {
      input["phonesToEdit"] = [
        {
          id: existingPhone.id,
          description: "MAIN",
          primary: true,
          number: phone,
        },
      ];
    } else {
      input["phonesToAdd"] = [
        { description: "MAIN", primary: true, number: phone },
      ];
    }
  } else if (existingPhone) {
    input["phonesToDelete"] = [existingPhone.id];
  }

  const data = await jobberGraphql<{
    clientEdit: {
      client: { id: string } | null;
      userErrors: UserError[];
    };
  }>(
    accessToken,
    `mutation EditClientContact($clientId: EncodedId!, $input: ClientEditInput!) {
      clientEdit(clientId: $clientId, input: $input) {
        client { id }
        userErrors { message path }
      }
    }`,
    { clientId: args.clientId, input },
  );
  assertNoUserErrors("clientEdit", data.clientEdit.userErrors);
  if (!data.clientEdit.client) {
    throw new Error("Jobber clientEdit returned no client");
  }
}

/**
 * The Jobber property this job happens at: an existing one when the street
 * matches, otherwise a new one on the same client. Returns null when the
 * booking has no address worth sending — a request can still be created, it
 * just won't have a place attached.
 */
export async function ensureJobberProperty(
  accessToken: string,
  args: {
    clientId: string;
    existing: JobberProperty[];
    address: JobberAddress;
  },
): Promise<string | null> {
  const wanted = addressKey(args.address.street1, args.address.street2);
  if (wanted) {
    const match = args.existing.find(
      (p) => addressKey(p.street1, p.street2) === wanted,
    );
    if (match) return match.id;
  }
  if (!hasAnyAddress(args.address)) {
    // Nothing to create. An existing single property is still better than
    // nothing — that is where this customer's work happens.
    return args.existing[0]?.id ?? null;
  }
  const data = await jobberGraphql<{
    propertyCreate: {
      properties: Array<{ id: string }> | null;
      userErrors: UserError[];
    };
  }>(
    accessToken,
    `mutation CreateProperty($clientId: EncodedId!, $input: PropertyCreateInput!) {
      propertyCreate(clientId: $clientId, input: $input) {
        properties { id }
        userErrors { message path }
      }
    }`,
    {
      clientId: args.clientId,
      input: { properties: [{ address: addressAttributes(args.address) }] },
    },
  );
  assertNoUserErrors("propertyCreate", data.propertyCreate.userErrors);
  return (
    data.propertyCreate.properties?.[0]?.id ?? args.existing[0]?.id ?? null
  );
}

/**
 * Keep the service address on an already-linked property in sync. Most
 * importantly, a missing `street2` is sent as null: omitting it tells Jobber
 * to retain the old unit or suite.
 */
export async function updateJobberProperty(
  accessToken: string,
  args: { propertyId: string; address: JobberAddress },
): Promise<void> {
  const data = await jobberGraphql<{
    propertyEdit: {
      property: { id: string } | null;
      userErrors: UserError[];
    };
  }>(
    accessToken,
    `mutation EditProperty($propertyId: EncodedId!, $input: PropertyEditInput!) {
      propertyEdit(propertyId: $propertyId, input: $input) {
        property { id }
        userErrors { message path }
      }
    }`,
    {
      propertyId: args.propertyId,
      input: {
        address: addressAttributes(args.address, {
          includeClearedStreet2: true,
        }),
      },
    },
  );
  assertNoUserErrors("propertyEdit", data.propertyEdit.userErrors);
}

/**
 * Create the work request in Jobber.
 *
 * The input is deliberately small: `clientId`, `propertyId` and `title` are
 * the only things Jobber needs, and everything else this booking knows goes
 * over as a note. Earlier versions passed a free-text `source` and an inline
 * `property`, neither of which exists on Jobber's input — every push was
 * rejected. Anything added here must exist on `RequestCreateInput`.
 */
export async function createJobberRequest(
  accessToken: string,
  args: {
    clientId: string;
    propertyId: string | null;
    title: string;
  },
): Promise<{ id: string; jobberWebUri: string | null }> {
  const data = await jobberGraphql<{
    requestCreate: {
      request: { id: string; jobberWebUri: string | null } | null;
      userErrors: UserError[];
    };
  }>(
    accessToken,
    `mutation CreateRequest($input: RequestCreateInput!) {
      requestCreate(input: $input) {
        request { id jobberWebUri }
        userErrors { message path }
      }
    }`,
    {
      input: {
        clientId: args.clientId,
        title: args.title,
        ...(args.propertyId ? { propertyId: args.propertyId } : {}),
      },
    },
  );
  assertNoUserErrors("requestCreate", data.requestCreate.userErrors);
  if (!data.requestCreate.request) {
    throw new Error("Jobber requestCreate returned no request");
  }
  return data.requestCreate.request;
}

/**
 * Attach a note to a Jobber *job* (not a request).
 *
 * This is how clocked time reaches Jobber. Their API exposes time sheet
 * entries for reading only — there is no create mutation for them — so the
 * hours land as a note on the job, where they are visible when the office
 * builds the invoice. Returns the note id so the same stretch of work is never
 * posted twice.
 */
export async function createJobberJobNote(
  accessToken: string,
  jobId: string,
  message: string,
): Promise<{ id: string }> {
  const data = await jobberGraphql<{
    jobCreateNote: {
      note: { id: string } | null;
      userErrors: UserError[];
    };
  }>(
    accessToken,
    `mutation AttachJobNote($jobId: EncodedId!, $message: String!) {
      jobCreateNote(jobId: $jobId, input: { message: $message }) {
        note { id }
        userErrors { message path }
      }
    }`,
    { jobId, message },
  );
  assertNoUserErrors("jobCreateNote", data.jobCreateNote.userErrors);
  if (!data.jobCreateNote.note) {
    throw new Error("Jobber jobCreateNote returned no note");
  }
  return data.jobCreateNote.note;
}

/**
 * Create an invoice in Jobber from the booking's quoted line items. The
 * invoice lands in Jobber as a normal unsent invoice, so the office reviews
 * and sends it from there — nothing goes to the customer from here.
 */
export async function createJobberInvoice(
  accessToken: string,
  args: {
    clientId: string;
    subject: string;
    lineItems: Array<{ name: string; quantity: number; unitPrice: number }>;
  },
): Promise<{ id: string; invoiceNumber: string | null }> {
  const data = await jobberGraphql<{
    invoiceCreate: {
      invoice: { id: string; invoiceNumber: string | null } | null;
      userErrors: UserError[];
    };
  }>(
    accessToken,
    `mutation CreateInvoice($input: InvoiceCreateAttributes!) {
      invoiceCreate(input: $input) {
        invoice { id invoiceNumber }
        userErrors { message path }
      }
    }`,
    {
      input: {
        clientId: args.clientId,
        subject: args.subject,
        lineItems: args.lineItems,
      },
    },
  );
  assertNoUserErrors("invoiceCreate", data.invoiceCreate.userErrors);
  if (!data.invoiceCreate.invoice) {
    throw new Error("Jobber invoiceCreate returned no invoice");
  }
  return data.invoiceCreate.invoice;
}

/**
 * Create the quote in Jobber, with the same line items the customer was
 * texted. It lands as a draft: Jobber never sends it, because the customer
 * already has our own quote link and must not be quoted twice.
 *
 * Jobber requires a property here (unlike a request), so the caller must have
 * resolved one first.
 */
export async function createJobberQuote(
  accessToken: string,
  args: {
    clientId: string;
    propertyId: string;
    requestId: string | null;
    title: string;
    message: string | null;
    lineItems: Array<{
      name: string;
      description?: string;
      quantity: number;
      unitPrice: number;
    }>;
  },
): Promise<{ id: string; quoteNumber: string | null; webUri: string | null }> {
  const data = await jobberGraphql<{
    quoteCreate: {
      quote: {
        id: string;
        quoteNumber: string | null;
        jobberWebUri: string | null;
      } | null;
      userErrors: UserError[];
    };
  }>(
    accessToken,
    `mutation CreateQuote($attributes: QuoteCreateAttributes!) {
      quoteCreate(attributes: $attributes) {
        quote { id quoteNumber jobberWebUri }
        userErrors { message path }
      }
    }`,
    {
      attributes: {
        clientId: args.clientId,
        propertyId: args.propertyId,
        ...(args.requestId ? { requestId: args.requestId } : {}),
        title: args.title,
        ...(args.message ? { message: args.message } : {}),
        lineItems: args.lineItems.map((item) => ({
          name: item.name,
          ...(item.description ? { description: item.description } : {}),
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          // Never add a booking's line to the company's saved price list —
          // that list is the owner's, not something a quote should edit.
          saveToProductsAndServices: false,
        })),
      },
    },
  );
  assertNoUserErrors("quoteCreate", data.quoteCreate.userErrors);
  if (!data.quoteCreate.quote) {
    throw new Error("Jobber quoteCreate returned no quote");
  }
  const quote = data.quoteCreate.quote;
  return {
    id: quote.id,
    quoteNumber: quote.quoteNumber,
    webUri: quote.jobberWebUri,
  };
}

export type JobberQuoteLine = {
  id: string;
  name: string;
  quantity: number;
  unitPrice: number;
};

export type JobberQuoteSummary = {
  id: string;
  quoteNumber: string | null;
  webUri: string | null;
  title: string | null;
  message: string | null;
  lineItems: JobberQuoteLine[];
};

/**
 * Read a quote back out of Jobber, with its line items.
 *
 * Needed because a booking raises its quote as a draft the moment it is
 * taken: by the time the office texts the customer a price, the quote is
 * already there and must be *edited*, not raised a second time. Returns null
 * when the quote is gone (deleted in Jobber), which is the signal to start
 * over rather than fail.
 */
export async function fetchJobberQuote(
  accessToken: string,
  quoteId: string,
): Promise<JobberQuoteSummary | null> {
  const data = await jobberGraphql<{
    quote: {
      id: string;
      quoteNumber: string | null;
      jobberWebUri: string | null;
      title: string | null;
      message: string | null;
      lineItems: {
        nodes: Array<{
          id: string;
          name: string;
          quantity: number;
          unitPrice: number;
        }>;
      };
    } | null;
  }>(
    accessToken,
    `query FetchQuote($id: EncodedId!) {
      quote(id: $id) {
        id
        quoteNumber
        jobberWebUri
        title
        message
        lineItems(first: 50) { nodes { id name quantity unitPrice } }
      }
    }`,
    { id: quoteId },
  );
  if (!data.quote) return null;
  return {
    id: data.quote.id,
    quoteNumber: data.quote.quoteNumber,
    webUri: data.quote.jobberWebUri,
    title: data.quote.title,
    message: data.quote.message,
    lineItems: data.quote.lineItems.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      quantity: n.quantity,
      unitPrice: n.unitPrice,
    })),
  };
}

function sameLine(
  a: { name: string; quantity: number; unitPrice: number },
  b: { name: string; quantity: number; unitPrice: number },
): boolean {
  return (
    a.name === b.name &&
    Math.abs(a.quantity - b.quantity) < 0.001 &&
    Math.abs(a.unitPrice - b.unitPrice) < 0.005
  );
}

/**
 * Bring an existing Jobber quote in line with what the booking now says.
 *
 * Jobber has no "replace this quote" call: the heading is `quoteEdit`, and
 * the priced lines are their own objects with their own ids. So the lines are
 * added before the stale ones are removed — a quote that momentarily holds
 * both is a quote the office can still read, whereas one that momentarily
 * holds none is not.
 *
 * Nothing is sent when nothing changed, which is the normal case: the draft
 * raised with the booking usually carries exactly the price that is later
 * texted, and re-sending it would churn the owner's quote history.
 */
export async function updateJobberQuote(
  accessToken: string,
  args: {
    quoteId: string;
    title: string;
    message: string | null;
    lineItems: Array<{ name: string; quantity: number; unitPrice: number }>;
  },
): Promise<JobberQuoteSummary | null> {
  const existing = await fetchJobberQuote(accessToken, args.quoteId);
  if (!existing) return null;

  const headingChanged =
    existing.title !== args.title ||
    (args.message !== null && (existing.message ?? "") !== args.message);
  if (headingChanged) {
    const data = await jobberGraphql<{
      quoteEdit: { quote: { id: string } | null; userErrors: UserError[] };
    }>(
      accessToken,
      `mutation EditQuote($quoteId: EncodedId!, $attributes: QuoteEditAttributes!) {
        quoteEdit(quoteId: $quoteId, attributes: $attributes) {
          quote { id }
          userErrors { message path }
        }
      }`,
      {
        quoteId: args.quoteId,
        attributes: {
          title: args.title,
          ...(args.message ? { message: args.message } : {}),
        },
      },
    );
    assertNoUserErrors("quoteEdit", data.quoteEdit.userErrors);
  }

  const linesChanged =
    existing.lineItems.length !== args.lineItems.length ||
    args.lineItems.some((want, i) => !sameLine(want, existing.lineItems[i]!));

  if (linesChanged) {
    const created = await jobberGraphql<{
      quoteCreateLineItems: {
        quote: { id: string } | null;
        userErrors: UserError[];
      };
    }>(
      accessToken,
      `mutation AddQuoteLines($quoteId: EncodedId!, $lineItems: [QuoteCreateLineItemAttributes!]!) {
        quoteCreateLineItems(quoteId: $quoteId, lineItems: $lineItems) {
          quote { id }
          userErrors { message path }
        }
      }`,
      {
        quoteId: args.quoteId,
        lineItems: args.lineItems.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          saveToProductsAndServices: false,
        })),
      },
    );
    assertNoUserErrors(
      "quoteCreateLineItems",
      created.quoteCreateLineItems.userErrors,
    );

    if (existing.lineItems.length > 0) {
      const removed = await jobberGraphql<{
        quoteDeleteLineItems: {
          quote: { id: string } | null;
          userErrors: UserError[];
        };
      }>(
        accessToken,
        `mutation RemoveQuoteLines($quoteId: EncodedId!, $lineItemIds: [EncodedId!]!) {
          quoteDeleteLineItems(quoteId: $quoteId, lineItemIds: $lineItemIds) {
            quote { id }
            userErrors { message path }
          }
        }`,
        {
          quoteId: args.quoteId,
          lineItemIds: existing.lineItems.map((l) => l.id),
        },
      );
      assertNoUserErrors(
        "quoteDeleteLineItems",
        removed.quoteDeleteLineItems.userErrors,
      );
    }
  }

  return existing;
}

/**
 * Jobber's own web URL for an invoice — the page the office reviews and
 * sends it from. Fetched separately from creation on purpose, and never
 * thrown: if this lookup breaks, the invoice still exists and the office
 * merely loses the one-click link.
 */
export async function getJobberInvoiceWebUri(
  accessToken: string,
  invoiceId: string,
): Promise<string | null> {
  try {
    const data = await jobberGraphql<{
      invoice: { jobberWebUri: string | null } | null;
    }>(
      accessToken,
      `query InvoiceWebUri($id: EncodedId!) {
        invoice(id: $id) { jobberWebUri }
      }`,
      { id: invoiceId },
    );
    return data.invoice?.jobberWebUri ?? null;
  } catch (err) {
    logger.warn({ err }, "Could not fetch Jobber invoice web uri");
    return null;
  }
}

/* ─────────── turning a quote into a real job ─────────── */

/** The company's own staff in Jobber — who a visit can be assigned to. */
export type JobberUser = { id: string; name: string };

/**
 * Enough pages to cover any real cleaning company several times over, while
 * still bounding a runaway cursor loop. This list is treated as COMPLETE by
 * callers — absence from it is read as "deactivated in Jobber" — so a company
 * genuinely bigger than this must fail loudly rather than return a partial
 * list that would flag active staff as gone.
 */
const MAX_JOBBER_USER_PAGES = 10;

export async function listJobberUsers(
  accessToken: string,
): Promise<JobberUser[]> {
  type JobberUsersPage = {
    users: {
      nodes: Array<{
        id: string;
        name: { full: string | null } | null;
      } | null>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
  const users: JobberUser[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_JOBBER_USER_PAGES; page++) {
    const data: JobberUsersPage = await jobberGraphql<JobberUsersPage>(
      accessToken,
      // Active staff only: assigning a visit to a deactivated user is either
      // rejected or invisible, and either way the crew never sees the job.
      // Paginated to exhaustion: the Team page reads absence from this list
      // as "their Jobber account is gone", so a partial page would falsely
      // accuse active staff.
      `query JobberUsers($after: String) {
        users(filter: { status: ACTIVATED }, first: 100, after: $after) {
          nodes { id name { full } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { after: cursor },
    );
    const nodes = data.users?.nodes ?? [];
    for (const u of nodes) {
      if (!u?.id) continue;
      const name = u.name?.full?.trim() ?? "";
      if (name.length > 0) users.push({ id: u.id, name });
    }
    const pageInfo = data.users?.pageInfo;
    if (!pageInfo?.hasNextPage) return users;
    if (!pageInfo.endCursor) {
      throw new Error("Jobber reported another page of users with no cursor");
    }
    cursor = pageInfo.endCursor;
  }
  throw new Error(
    "Jobber reported more team members than expected — refusing a partial list",
  );
}

export type JobberScheduledJob = {
  id: string;
  webUri: string | null;
  visitId: string | null;
};

/**
 * Turn an approved quote into a scheduled job on the Jobber calendar.
 *
 * The date and the time of day go over separately because that is the shape
 * Jobber's input has: the job's `timeframe` carries the day, and the
 * scheduling block carries the wall-clock window the visit occupies. Both are
 * computed in the company's own timezone by the caller — Jobber reads them
 * against the account's zone, so sending UTC would land the crew on the wrong
 * hour.
 *
 * Invoicing is set to the plainest thing Jobber will accept (bill once the
 * work is done): this app raises its own invoices from the Bookings page, and
 * anything else here would start a second, automatic billing schedule.
 */
export async function createJobberJobFromQuote(
  accessToken: string,
  args: {
    quoteId: string;
    /** YYYY-MM-DD in the company's timezone. */
    startDate: string;
    /** HH:MM:SS in the company's timezone. */
    startTime: string;
    endTime: string;
    assignedUserIds: string[];
  },
): Promise<JobberScheduledJob> {
  const data = await jobberGraphql<{
    jobCreateFromQuote: {
      job: {
        id: string;
        jobberWebUri: string | null;
        visits: { nodes: Array<{ id: string } | null> } | null;
      } | null;
      userErrors: UserError[];
    };
  }>(
    accessToken,
    `mutation ScheduleJobFromQuote($quoteId: EncodedId!, $input: JobCreateFromQuoteAttributes!) {
      jobCreateFromQuote(quoteId: $quoteId, input: $input) {
        job {
          id
          jobberWebUri
          visits(first: 1) { nodes { id } }
        }
        userErrors { message path }
      }
    }`,
    {
      quoteId: args.quoteId,
      input: {
        scheduling: {
          createVisits: true,
          // The crew hears about the job from this app's own schedule; a
          // second Jobber notification for the same visit is noise.
          notifyTeam: false,
          startTime: args.startTime,
          endTime: args.endTime,
          ...(args.assignedUserIds.length > 0
            ? { assignedTo: args.assignedUserIds }
            : {}),
        },
        invoicing: {
          invoicingType: "FIXED_PRICE",
          invoicingSchedule: "ON_COMPLETION",
        },
        timeframe: {
          startAt: args.startDate,
          durationUnits: "DAYS",
          durationValue: 1,
        },
      },
    },
  );
  assertNoUserErrors(
    "jobCreateFromQuote",
    data.jobCreateFromQuote.userErrors ?? [],
  );
  const job = data.jobCreateFromQuote.job;
  if (!job) throw new Error("Jobber jobCreateFromQuote returned no job");
  return {
    id: job.id,
    webUri: job.jobberWebUri,
    visitId: job.visits?.nodes?.[0]?.id ?? null,
  };
}

/**
 * The first visit of a job, read back when creation didn't hand one over.
 * Jobber generates visits asynchronously for some jobs, so the id we need to
 * move later can arrive a beat after the job itself. Never throws: without it
 * we simply can't move the visit from here, which is reported honestly.
 */
export async function fetchJobberFirstVisitId(
  accessToken: string,
  jobId: string,
): Promise<string | null> {
  try {
    const data = await jobberGraphql<{
      job: { visits: { nodes: Array<{ id: string } | null> } | null } | null;
    }>(
      accessToken,
      `query JobFirstVisit($id: EncodedId!) {
        job(id: $id) { visits(first: 1) { nodes { id } } }
      }`,
      { id: jobId },
    );
    return data.job?.visits?.nodes?.[0]?.id ?? null;
  } catch (err) {
    logger.warn({ err }, "Could not read the Jobber job's first visit");
    return null;
  }
}

/**
 * The job Jobber already holds for this quote, if there is one.
 *
 * Asked before ever creating one. A job created in Jobber whose id never
 * reached our database — the write failed, the process died, a claim was
 * taken — is invisible here, and without this lookup the next click would
 * put a second clean on the customer's calendar. Jobber's own record is the
 * reconciliation key: a quote knows the jobs made from it.
 */
export async function fetchJobberJobForQuote(
  accessToken: string,
  quoteId: string,
): Promise<JobberScheduledJob | null> {
  const data = await jobberGraphql<{
    quote: {
      jobs: {
        nodes: Array<{
          id: string;
          jobberWebUri: string | null;
          visits: { nodes: Array<{ id: string } | null> } | null;
        } | null>;
      } | null;
    } | null;
  }>(
    accessToken,
    `query QuoteExistingJob($id: EncodedId!) {
      quote(id: $id) {
        jobs(first: 1) {
          nodes { id jobberWebUri visits(first: 1) { nodes { id } } }
        }
      }
    }`,
    { id: quoteId },
  );
  const job = data.quote?.jobs?.nodes?.[0];
  if (!job?.id) return null;
  return {
    id: job.id,
    webUri: job.jobberWebUri ?? null,
    visitId: job.visits?.nodes?.[0]?.id ?? null,
  };
}

/**
 * Move a visit already on the Jobber calendar. Unlike job creation, this input
 * names its timezone explicitly, so the wall-clock time we send is the one the
 * crew sees whatever zone the Jobber account is set to.
 */
export async function editJobberVisitSchedule(
  accessToken: string,
  args: {
    visitId: string;
    /** YYYY-MM-DD and HH:MM:SS in `timezone`. */
    startDate: string;
    startTime: string;
    endDate: string;
    endTime: string;
    timezone: string;
  },
): Promise<void> {
  const data = await jobberGraphql<{
    visitEditSchedule: { userErrors: UserError[] };
  }>(
    accessToken,
    `mutation MoveVisit($id: EncodedId!, $input: VisitEditScheduleInput!) {
      visitEditSchedule(id: $id, input: $input) {
        visit { id }
        userErrors { message path }
      }
    }`,
    {
      id: args.visitId,
      input: {
        startAt: {
          date: args.startDate,
          time: args.startTime,
          timezone: args.timezone,
        },
        endAt: {
          date: args.endDate,
          time: args.endTime,
          timezone: args.timezone,
        },
      },
    },
  );
  assertNoUserErrors(
    "visitEditSchedule",
    data.visitEditSchedule.userErrors ?? [],
  );
}

/** Replace who is on a visit in Jobber. An empty list unassigns it. */
export async function editJobberVisitAssignedUsers(
  accessToken: string,
  args: { visitId: string; assignedUserIds: string[] },
): Promise<void> {
  const data = await jobberGraphql<{
    visitEditAssignedUsers: { userErrors: UserError[] };
  }>(
    accessToken,
    `mutation ReassignVisit($visitId: EncodedId!, $input: VisitEditAssignedUsersInput!) {
      visitEditAssignedUsers(visitId: $visitId, input: $input) {
        visit { id }
        userErrors { message path }
      }
    }`,
    {
      visitId: args.visitId,
      input: { assignedUserIds: args.assignedUserIds },
    },
  );
  assertNoUserErrors(
    "visitEditAssignedUsers",
    data.visitEditAssignedUsers.userErrors ?? [],
  );
}

/**
 * Best-effort: attach the wizard answers to the request as a note. Note
 * mutations vary by API version, so a failure here must not fail the sync.
 */
export async function tryAttachRequestNote(
  accessToken: string,
  requestId: string,
  message: string,
): Promise<boolean> {
  try {
    const data = await jobberGraphql<{
      requestCreateNote: {
        requestNote: { id: string } | null;
        userErrors: UserError[];
      };
    }>(
      accessToken,
      // Notes hang off their subject's own mutation; there is no generic
      // `noteCreate` on Jobber's Mutation type.
      `mutation AttachNote($requestId: EncodedId!, $body: String!) {
        requestCreateNote(requestId: $requestId, input: { message: $body }) {
          requestNote { id }
          userErrors { message }
        }
      }`,
      { requestId, body: message },
    );
    assertNoUserErrors("requestCreateNote", data.requestCreateNote.userErrors);
    return true;
  } catch (err) {
    logger.warn({ err }, "Could not attach note to Jobber request");
    return false;
  }
}

/**
 * The requests already hanging off a client. The lead push uses this to
 * reconcile an interrupted attempt: a client created for a website lead is
 * that lead's alone (never matched onto an existing customer), so any
 * request found on it was made by an earlier attempt at the same lead and
 * must be adopted — asking Jobber is the only party that can prove whether
 * the request already exists.
 */
export async function listJobberClientRequests(
  accessToken: string,
  clientId: string,
): Promise<{ id: string; jobberWebUri: string | null }[]> {
  const data = await jobberGraphql<{
    client: {
      requests: { nodes: { id: string; jobberWebUri: string | null }[] };
    } | null;
  }>(
    accessToken,
    `query LeadClientRequests($clientId: EncodedId!) {
      client(id: $clientId) {
        requests(first: 10) {
          nodes { id jobberWebUri }
        }
      }
    }`,
    { clientId },
  );
  return data.client?.requests?.nodes ?? [];
}

/**
 * Best-effort cleanup when a push attempt loses its claim after creating a
 * client: archive the orphan so the owner never sees two active clients for
 * one enquiry. Never throws — the winning attempt's record is already the
 * correct one, and a failed archive is a log line, not a failure.
 */
export async function tryArchiveJobberClient(
  accessToken: string,
  clientId: string,
): Promise<boolean> {
  try {
    const data = await jobberGraphql<{
      clientArchive: { client: { id: string } | null; userErrors: UserError[] };
    }>(
      accessToken,
      `mutation ArchiveOrphanClient($clientId: EncodedId!) {
        clientArchive(clientId: $clientId) {
          client { id }
          userErrors { message }
        }
      }`,
      { clientId },
    );
    assertNoUserErrors("clientArchive", data.clientArchive.userErrors);
    return true;
  } catch (err) {
    logger.warn({ err, clientId }, "Could not archive orphaned Jobber client");
    return false;
  }
}

/** Same best-effort cleanup for a request created just as the claim was lost. */
export async function tryArchiveJobberRequest(
  accessToken: string,
  requestId: string,
): Promise<boolean> {
  try {
    const data = await jobberGraphql<{
      requestArchive: {
        request: { id: string } | null;
        userErrors: UserError[];
      };
    }>(
      accessToken,
      `mutation ArchiveOrphanRequest($requestId: EncodedId!) {
        requestArchive(requestId: $requestId) {
          request { id }
          userErrors { message }
        }
      }`,
      { requestId },
    );
    assertNoUserErrors("requestArchive", data.requestArchive.userErrors);
    return true;
  } catch (err) {
    logger.warn(
      { err, requestId },
      "Could not archive orphaned Jobber request",
    );
    return false;
  }
}
