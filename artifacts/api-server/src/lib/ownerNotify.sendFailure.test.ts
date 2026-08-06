import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Owner notifications are best-effort — they must never throw — but the
 * caller still needs to know when a send failed so it can release its
 * one-per-outage claim and retry later. These tests pin the outcome contract
 * for the send-failure path of both the dead-key and back-online texts.
 */

const listPhoneNumbers = vi.fn();
const sendMessage = vi.fn();
vi.mock("./quo", () => ({
  listPhoneNumbers: (...args: unknown[]) => listPhoneNumbers(...(args as [])),
  sendMessage: (...args: unknown[]) => sendMessage(...(args as [])),
  toE164: (n: string) => n,
}));
vi.mock("./publicUrl", () => ({ publicBaseUrl: () => "https://example.com" }));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { notifyOwnerQuoKeyDead, notifyOwnerQuoRestored } from "./ownerNotify";
import type { Company } from "@workspace/db";

const company = {
  id: 1,
  name: "Sparkle Co",
  ringThroughNumber: "+15550001234",
} as unknown as Company;

beforeEach(() => {
  process.env.QUO_API_KEY = "test-platform-key";
  listPhoneNumbers.mockReset();
  listPhoneNumbers.mockResolvedValue([{ number: "+15559990000" }]);
  sendMessage.mockReset();
});

describe("owner notification send failures", () => {
  it("dead-key text: returns 'failed' (without throwing) when the send errors", async () => {
    sendMessage.mockRejectedValue(new Error("Quo 502"));
    await expect(notifyOwnerQuoKeyDead(company)).resolves.toBe("failed");
  });

  it("back-online text: returns 'failed' (without throwing) when the send errors", async () => {
    sendMessage.mockRejectedValue(new Error("network reset"));
    await expect(notifyOwnerQuoRestored(company)).resolves.toBe("failed");
  });

  it("returns 'sent' when the send succeeds", async () => {
    sendMessage.mockResolvedValue({ id: "msg_1" });
    await expect(notifyOwnerQuoKeyDead(company)).resolves.toBe("sent");
    await expect(notifyOwnerQuoRestored(company)).resolves.toBe("sent");
  });

  it("returns 'skipped' for configuration gaps (no ring-through number)", async () => {
    const noNumber = { ...company, ringThroughNumber: null } as Company;
    await expect(notifyOwnerQuoKeyDead(noNumber)).resolves.toBe("skipped");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
