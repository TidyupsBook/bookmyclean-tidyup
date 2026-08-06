import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * notifyOwnerQuoKeyDead is best-effort: any failure (Quo API down, missing
 * platform key, no usable number) must resolve without throwing, so a
 * notification hiccup can never break the health check loop or a webhook
 * handler that awaits it.
 */

const listPhoneNumbers = vi.fn();
const sendMessage = vi.fn();
vi.mock("./quo", () => ({
  listPhoneNumbers: (...args: unknown[]) => listPhoneNumbers(...(args as [])),
  sendMessage: (...args: unknown[]) => sendMessage(...(args as [])),
  toE164: (n: string) => (n.startsWith("+") ? n : `+1${n}`),
}));

vi.mock("./publicUrl", () => ({
  publicBaseUrl: () => "https://example.test",
}));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock("./logger", () => ({ logger }));

import type { Company } from "@workspace/db";

const company = {
  id: 1,
  name: "Sparkle Co",
  ringThroughNumber: "5551234567",
} as unknown as Company;

/**
 * The module caches the platform "from" number after the first successful
 * lookup, so each test imports a fresh copy to stay independent.
 */
async function freshNotify() {
  vi.resetModules();
  const mod = await import("./ownerNotify");
  return mod.notifyOwnerQuoKeyDead;
}

beforeEach(() => {
  vi.stubEnv("QUO_API_KEY", "platform-key");
  listPhoneNumbers.mockReset();
  sendMessage.mockReset();
  logger.error.mockClear();
  logger.warn.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("notifyOwnerQuoKeyDead", () => {
  it("sends one text on the happy path", async () => {
    listPhoneNumbers.mockResolvedValue([{ id: "n1", number: "+15550001111" }]);
    sendMessage.mockResolvedValue(undefined);
    const notify = await freshNotify();
    await notify(company);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("resolves without throwing when sending the text fails", async () => {
    listPhoneNumbers.mockResolvedValue([{ id: "n1", number: "+15550001111" }]);
    sendMessage.mockRejectedValue(new Error("Quo is down"));
    const notify = await freshNotify();
    await expect(notify(company)).resolves.toBe("failed");
    expect(logger.error).toHaveBeenCalled();
  });

  it("resolves without throwing when the platform number lookup fails", async () => {
    listPhoneNumbers.mockRejectedValue(new Error("network error"));
    const notify = await freshNotify();
    await expect(notify(company)).resolves.toBe("failed");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it("resolves (with a warning, no send) when QUO_API_KEY is unset", async () => {
    vi.stubEnv("QUO_API_KEY", "");
    const notify = await freshNotify();
    await expect(notify(company)).resolves.toBe("skipped");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("falls back to the notification number when there is no ring-through number", async () => {
    listPhoneNumbers.mockResolvedValue([{ id: "n1", number: "+15550001111" }]);
    sendMessage.mockResolvedValue(undefined);
    const notify = await freshNotify();
    await notify({
      ...company,
      ringThroughNumber: null,
      notificationNumber: "5559876543",
    } as unknown as Company);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).toMatchObject({ to: "+15559876543" });
  });

  it("resolves (with a warning, no send) when the company has no ring-through or notification number", async () => {
    const notify = await freshNotify();
    await expect(
      notify({
        ...company,
        ringThroughNumber: null,
        notificationNumber: null,
      } as unknown as Company),
    ).resolves.toBe("skipped");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
