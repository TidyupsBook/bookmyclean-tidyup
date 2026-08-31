import { describe, it, expect } from "vitest";
import { formatPhone, telHref, smsHref } from "./phone";

describe("formatPhone", () => {
  it("reads back a North-American number the way people say it", () => {
    expect(formatPhone("+17807185092")).toBe("(780) 718-5092");
    expect(formatPhone("7807185092")).toBe("(780) 718-5092");
  });

  it("leaves anything else exactly as it was typed", () => {
    expect(formatPhone("+441632960961")).toBe("+441632960961");
    expect(formatPhone("")).toBe("");
    expect(formatPhone(null)).toBe("");
  });
});

describe("telHref / smsHref", () => {
  it("strips the punctuation but keeps the country code", () => {
    expect(telHref("(780) 718-5092")).toBe("tel:7807185092");
    expect(smsHref("+1 780 718 5092")).toBe("sms:+17807185092");
  });

  it("gives nothing back when there is nothing to dial", () => {
    expect(telHref("n/a")).toBeNull();
    expect(smsHref(null)).toBeNull();
    expect(telHref("718")).toBeNull();
  });
});
