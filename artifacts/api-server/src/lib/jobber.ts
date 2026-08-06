import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db, companiesTable, type Company } from "@workspace/db";
import { logger } from "./logger";
import { encryptJobberToken, decryptJobberToken } from "./secretBox";

const JOBBER_AUTHORIZE_URL = "https://api.getjobber.com/api/oauth/authorize";
const JOBBER_TOKEN_URL = "https://api.getjobber.com/api/oauth/token";
const JOBBER_GRAPHQL_URL = "https://api.getjobber.com/api/graphql";
const JOBBER_GRAPHQL_VERSION = "2025-04-16";

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
 * Returns a valid access token for the company, refreshing (and persisting the
 * rotated refresh token) when the stored token is expired or about to expire.
 */
export async function getValidAccessToken(company: Company): Promise<string> {
  if (!company.jobberRefreshToken || !company.jobberAccessToken) {
    throw new Error("Jobber is not connected for this company");
  }
  const accessToken = decryptJobberToken(company.jobberAccessToken);
  if (!accessToken)
    throw new Error(
      "Jobber access token could not be decrypted — reconnect Jobber",
    );
  const refreshToken = decryptJobberToken(company.jobberRefreshToken);
  if (!refreshToken)
    throw new Error(
      "Jobber refresh token could not be decrypted — reconnect Jobber",
    );

  const expiresAt = company.jobberTokenExpiresAt?.getTime() ?? 0;
  const stillValid = expiresAt - Date.now() > 60_000;
  if (stillValid) return accessToken;

  let tokens: TokenResponse;
  try {
    tokens = await refreshTokens(refreshToken);
  } catch (err) {
    if (err instanceof JobberTokenError && err.grantRejected) {
      // The tokens are known-dead. Flag the company so the UI switches from
      // "Sync" to "Reconnect Jobber" instead of failing on every attempt.
      await db
        .update(companiesTable)
        .set({ jobberNeedsReauth: true })
        .where(eq(companiesTable.id, company.id));
      logger.warn(
        { companyId: company.id },
        "Jobber refresh token rejected; company flagged for reconnect",
      );
      throw new Error(
        "Jobber authorization has expired — reconnect Jobber to keep syncing.",
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
    })
    .where(eq(companiesTable.id, company.id));
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

export async function disconnectJobberApp(accessToken: string): Promise<void> {
  await jobberGraphql(
    accessToken,
    `mutation { appDisconnect { userErrors { message } } }`,
  );
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

export async function createJobberClient(
  accessToken: string,
  args: { name: string; phone: string },
): Promise<{ id: string }> {
  const { firstName, lastName } = splitName(args.name);
  const data = await jobberGraphql<{
    clientCreate: { client: { id: string } | null; userErrors: UserError[] };
  }>(
    accessToken,
    `mutation CreateClient($firstName: String!, $lastName: String!, $phone: String!) {
      clientCreate(input: {
        firstName: $firstName
        lastName: $lastName
        phones: [{ description: MAIN, primary: true, number: $phone }]
      }) {
        client { id }
        userErrors { message path }
      }
    }`,
    { firstName, lastName, phone: args.phone },
  );
  assertNoUserErrors("clientCreate", data.clientCreate.userErrors);
  if (!data.clientCreate.client) {
    throw new Error("Jobber clientCreate returned no client");
  }
  return data.clientCreate.client;
}

export async function createJobberRequest(
  accessToken: string,
  args: {
    clientId: string;
    title: string;
    address: string | null;
  },
): Promise<{ id: string; jobberWebUri: string | null }> {
  const property = args.address
    ? { addressAttributes: { street1: args.address } }
    : undefined;
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
        source: "Book My Cleaning AI receptionist",
        ...(property ? { property } : {}),
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
      noteCreate: {
        note: { id: string } | null;
        userErrors: UserError[];
      };
    }>(
      accessToken,
      `mutation AttachNote($subjectId: EncodedId!, $body: String!) {
        noteCreate(input: { subjectId: $subjectId, subjectType: REQUEST, body: $body }) {
          note { id }
          userErrors { message }
        }
      }`,
      { subjectId: requestId, body: message },
    );
    assertNoUserErrors("noteCreate", data.noteCreate.userErrors);
    return true;
  } catch (err) {
    logger.warn({ err }, "Could not attach note to Jobber request");
    return false;
  }
}
