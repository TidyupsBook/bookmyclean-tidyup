import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Jobber auto-refresh path has never run against a live account, so pin
 * its behavior here: an expired stored token must trigger a refresh_token
 * grant, persist the rotated tokens, and a rejected grant (400/401) must flag
 * the company for reconnect instead of failing every future sync attempt.
 */

type Row = {
  id: number;
  jobberAccessToken: string | null;
  jobberRefreshToken: string | null;
  jobberTokenExpiresAt: Date | null;
  jobberNeedsReauth: boolean;
};

let row: Row;
let lastSet: Record<string, unknown> | null;

vi.mock("@workspace/db", () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          lastSet = values;
          Object.assign(row, values);
        },
      }),
    }),
  },
  companiesTable: { id: { __col: "id" } },
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
}));

// Encryption is a passthrough with a marker so we can assert re-encryption.
vi.mock("./secretBox", () => ({
  encryptJobberToken: (v: string) => `enc:${v}`,
  decryptJobberToken: (v: string) => (v.startsWith("enc:") ? v.slice(4) : null),
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import {
  getValidAccessToken,
  friendlyTokenExchangeError,
  JobberTokenError,
} from "./jobber";
import type { Company } from "@workspace/db";

const company = (overrides: Partial<Row> = {}): Company => {
  row = {
    id: 1,
    jobberAccessToken: "enc:old-access",
    jobberRefreshToken: "enc:old-refresh",
    jobberTokenExpiresAt: new Date(Date.now() - 1000),
    jobberNeedsReauth: false,
    ...overrides,
  };
  return row as unknown as Company;
};

beforeEach(() => {
  process.env["JOBBER_CLIENT_ID"] = "test-client-id";
  process.env["JOBBER_CLIENT_SECRET"] = "test-client-secret";
  lastSet = null;
  fetchMock.mockReset();
});

describe("getValidAccessToken", () => {
  it("returns the stored token without calling Jobber when it is still valid", async () => {
    const c = company({
      jobberTokenExpiresAt: new Date(Date.now() + 10 * 60_000),
    });
    await expect(getValidAccessToken(c)).resolves.toBe("old-access");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes an expired token and persists the rotated pair encrypted", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
    });
    await expect(getValidAccessToken(company())).resolves.toBe("new-access");

    // The refresh grant went to Jobber with the decrypted refresh token.
    const body = fetchMock.mock.calls[0]![1].body as string;
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=old-refresh");

    // Rotated tokens are stored encrypted, with a fresh expiry.
    expect(row.jobberAccessToken).toBe("enc:new-access");
    expect(row.jobberRefreshToken).toBe("enc:new-refresh");
    expect(row.jobberTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("keeps the old refresh token when Jobber does not rotate it", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({ access_token: "new-access", refresh_token: "" }),
    });
    await getValidAccessToken(company());
    expect(row.jobberRefreshToken).toBe("enc:old-refresh");
  });

  it("flags the company for reconnect when the refresh grant is rejected", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    await expect(getValidAccessToken(company())).rejects.toThrow(
      /reconnect Jobber/i,
    );
    expect(row.jobberNeedsReauth).toBe(true);
    expect(lastSet).toEqual({ jobberNeedsReauth: true });
  });

  it("does not flag reconnect on a transient (5xx) refresh failure", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => "Bad gateway",
    });
    await expect(getValidAccessToken(company())).rejects.toThrow(
      JobberTokenError,
    );
    expect(row.jobberNeedsReauth).toBe(false);
  });

  it("demands reconnect when a stored token cannot be decrypted", async () => {
    await expect(
      getValidAccessToken(company({ jobberAccessToken: "garbage" })),
    ).rejects.toThrow(/reconnect Jobber/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("friendlyTokenExchangeError", () => {
  const tokenErr = (body: string) => new JobberTokenError(body, true);

  it("points at server credentials when the client pair is wrong", () => {
    expect(
      friendlyTokenExchangeError(
        tokenErr(
          "Jobber token endpoint returned 401: The provided client id and secret do not match an existing application",
        ),
      ),
    ).toMatch(/JOBBER_CLIENT_ID/);
  });

  it("points at the callback URL when the code/redirect is rejected", () => {
    expect(
      friendlyTokenExchangeError(
        tokenErr(
          "Jobber token endpoint returned 400: The provided authorization code was not valid.",
        ),
      ),
    ).toMatch(/callback URL/i);
  });

  it("falls back to a generic retry message for unknown errors", () => {
    expect(friendlyTokenExchangeError(new Error("boom"))).toMatch(/try again/i);
  });
});
