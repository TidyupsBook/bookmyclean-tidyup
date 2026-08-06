import { describe, expect, it } from "vitest";
import { normalizePhoneField } from "./phoneField";
import { toE164 } from "./quo";

describe("normalizePhoneField", () => {
  it("normalizes a hand-typed domestic number to E.164", () => {
    expect(normalizePhoneField("555-123-4567", "notification number")).toEqual({
      ok: true,
      value: "+15551234567",
    });
    expect(
      normalizePhoneField("(555) 123 4567", "notification number"),
    ).toEqual({ ok: true, value: "+15551234567" });
  });

  it("keeps a valid international number as-is", () => {
    expect(normalizePhoneField("+447911123456", "ring-through number")).toEqual(
      { ok: true, value: "+447911123456" },
    );
  });

  it("passes undefined through (field not being updated)", () => {
    expect(normalizePhoneField(undefined, "notification number")).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("allows blank / whitespace-only input to clear the number", () => {
    expect(normalizePhoneField("", "notification number")).toEqual({
      ok: true,
      value: "",
    });
    expect(normalizePhoneField("   ", "notification number")).toEqual({
      ok: true,
      value: "",
    });
  });

  it("rejects a number that is too short to dial", () => {
    const result = normalizePhoneField("555-12", "notification number");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("555-12");
      expect(result.error).toContain("notification number");
    }
  });

  it("rejects all-zero and leading-zero inputs that aren't valid E.164", () => {
    expect(normalizePhoneField("00000000", "notification number").ok).toBe(
      false,
    );
    expect(normalizePhoneField("012345678", "ring-through number").ok).toBe(
      false,
    );
  });
});

describe("toE164 E.164 enforcement", () => {
  it("never emits a number with a zero country code", () => {
    expect(toE164("00000000")).toBeNull();
    expect(toE164("0123456789012")).toBeNull();
  });

  it("still accepts valid inputs", () => {
    expect(toE164("5551234567")).toBe("+15551234567");
    expect(toE164("1-555-123-4567")).toBe("+15551234567");
    expect(toE164("+15551234567")).toBe("+15551234567");
    // 12 digits — too long for the 10-digit domestic rule, kept international.
    expect(toE164("44 7911 123456")).toBe("+447911123456");
  });
});
