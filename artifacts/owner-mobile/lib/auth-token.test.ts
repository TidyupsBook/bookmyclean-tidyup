import { describe, expect, it, vi } from "vitest";
import {
  createResilientTokenGetter,
  isUnauthorizedError,
  MAX_UNAUTHORIZED_RETRIES,
  profileRetryPolicy,
  requestFreshToken,
} from "./auth-token";

describe("createResilientTokenGetter", () => {
  it("returns the cached token when it is there", async () => {
    const getToken = vi.fn().mockResolvedValue("tok_1");
    await expect(createResilientTokenGetter(getToken)()).resolves.toBe("tok_1");
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it("forces a refresh when the first read throws", async () => {
    const getToken = vi
      .fn()
      .mockRejectedValueOnce(new Error("network request failed"))
      .mockResolvedValueOnce("tok_2");

    await expect(createResilientTokenGetter(getToken)()).resolves.toBe("tok_2");
    expect(getToken).toHaveBeenLastCalledWith({ skipCache: true });
  });

  it("forces a refresh when the cache comes back empty", async () => {
    const getToken = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("tok_3");

    await expect(createResilientTokenGetter(getToken)()).resolves.toBe("tok_3");
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it("gives up quietly instead of throwing at the fetch layer", async () => {
    const getToken = vi.fn().mockRejectedValue(new Error("still offline"));
    await expect(createResilientTokenGetter(getToken)()).resolves.toBeNull();
  });

  it("skips the cache once after requestFreshToken, then goes back to cached reads", async () => {
    const getToken = vi.fn().mockResolvedValue("tok_fresh");
    const getter = createResilientTokenGetter(getToken);

    requestFreshToken();
    await expect(getter()).resolves.toBe("tok_fresh");
    expect(getToken).toHaveBeenLastCalledWith({ skipCache: true });

    await getter();
    expect(getToken).toHaveBeenLastCalledWith(undefined);
  });

  it("does not double-refresh when a forced-fresh read comes back empty", async () => {
    const getToken = vi.fn().mockResolvedValue(null);
    const getter = createResilientTokenGetter(getToken);

    requestFreshToken();
    await expect(getter()).resolves.toBeNull();
    expect(getToken).toHaveBeenCalledTimes(1);
  });
});

describe("isUnauthorizedError", () => {
  it("matches an ApiError-shaped 401", () => {
    expect(isUnauthorizedError({ status: 401 })).toBe(true);
  });

  it("rejects other statuses, plain errors, and nullish values", () => {
    expect(isUnauthorizedError({ status: 500 })).toBe(false);
    expect(isUnauthorizedError(new Error("boom"))).toBe(false);
    expect(isUnauthorizedError(null)).toBe(false);
    expect(isUnauthorizedError(undefined)).toBe(false);
  });
});

describe("profileRetryPolicy", () => {
  it("retries a transient 401 with a forced-fresh token", async () => {
    const getToken = vi.fn().mockResolvedValue("tok_new");
    const getter = createResilientTokenGetter(getToken);

    expect(profileRetryPolicy(0, { status: 401 })).toBe(true);
    // The retry that follows must skip the cache — same expired token again
    // would just 401 again.
    await getter();
    expect(getToken).toHaveBeenLastCalledWith({ skipCache: true });
  });

  it("stops retrying 401s after the bounded number of attempts", () => {
    expect(profileRetryPolicy(MAX_UNAUTHORIZED_RETRIES, { status: 401 })).toBe(
      false,
    );
  });

  it("keeps default retries for non-auth failures", () => {
    expect(profileRetryPolicy(0, new Error("network"))).toBe(true);
    expect(profileRetryPolicy(2, new Error("network"))).toBe(true);
    expect(profileRetryPolicy(3, new Error("network"))).toBe(false);
  });
});
