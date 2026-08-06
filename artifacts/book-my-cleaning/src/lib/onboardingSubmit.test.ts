import { describe, it, expect, vi } from "vitest";
import { runOnboardingSubmit } from "./onboardingSubmit";

describe("runOnboardingSubmit", () => {
  it("creates the company and skips the update when no number was given", async () => {
    const createCompany = vi.fn().mockResolvedValue({});
    const saveNotificationNumber = vi.fn();

    const result = await runOnboardingSubmit({
      createCompany,
      saveNotificationNumber,
      notificationNumber: "   ",
    });

    expect(result).toEqual({ outcome: "done" });
    expect(createCompany).toHaveBeenCalledTimes(1);
    expect(saveNotificationNumber).not.toHaveBeenCalled();
  });

  it("saves the trimmed number via the update endpoint after creating", async () => {
    const order: string[] = [];
    const createCompany = vi.fn(async () => {
      order.push("create");
    });
    const saveNotificationNumber = vi.fn(async () => {
      order.push("update");
    });

    const result = await runOnboardingSubmit({
      createCompany,
      saveNotificationNumber,
      notificationNumber: " 555-123-4567 ",
    });

    expect(result).toEqual({ outcome: "done" });
    expect(saveNotificationNumber).toHaveBeenCalledWith("555-123-4567");
    expect(order).toEqual(["create", "update"]);
  });

  it("reports a failed number save instead of swallowing it", async () => {
    const boom = new Error("network down");
    const result = await runOnboardingSubmit({
      createCompany: vi.fn().mockResolvedValue({}),
      saveNotificationNumber: vi.fn().mockRejectedValue(boom),
      notificationNumber: "555-123-4567",
    });

    expect(result).toEqual({ outcome: "number_save_failed", error: boom });
  });

  it("propagates a create failure without attempting the update", async () => {
    const saveNotificationNumber = vi.fn();
    await expect(
      runOnboardingSubmit({
        createCompany: vi.fn().mockRejectedValue(new Error("create failed")),
        saveNotificationNumber,
        notificationNumber: "555-123-4567",
      }),
    ).rejects.toThrow("create failed");
    expect(saveNotificationNumber).not.toHaveBeenCalled();
  });
});
