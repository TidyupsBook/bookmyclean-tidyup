// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  acknowledgeWebsiteLeads,
  acknowledgedWebsiteLeadIds,
  websiteLeadAckStorageKey,
} from "./websiteLeadAlerts";

describe("website lead acknowledgements", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("keeps existing website leads quiet after a reload", () => {
    acknowledgeWebsiteLeads(12, [101, 102]);

    // Reading the store again models a fresh page load.
    expect(acknowledgedWebsiteLeadIds(12)).toEqual(new Set([101, 102]));
  });

  it("adds a newly returned lead without disturbing earlier acknowledgements", () => {
    acknowledgeWebsiteLeads(12, [101]);
    expect(acknowledgedWebsiteLeadIds(12).has(102)).toBe(false);

    // Opening the inbox acknowledges the currently visible website request.
    acknowledgeWebsiteLeads(12, [102]);
    expect(acknowledgedWebsiteLeadIds(12)).toEqual(new Set([101, 102]));
  });

  it("does not let one company's acknowledgements affect another company", () => {
    acknowledgeWebsiteLeads("company-a", [101]);

    expect(acknowledgedWebsiteLeadIds("company-a")).toEqual(new Set([101]));
    expect(acknowledgedWebsiteLeadIds("company-b")).toEqual(new Set());

    acknowledgeWebsiteLeads("company-b", [202]);
    expect(acknowledgedWebsiteLeadIds("company-a")).toEqual(new Set([101]));
    expect(acknowledgedWebsiteLeadIds("company-b")).toEqual(new Set([202]));
  });

  it("exposes a company-specific storage key for cross-tab updates", () => {
    expect(websiteLeadAckStorageKey(12)).toBe("website-lead-alert-ack:12");
    expect(websiteLeadAckStorageKey("company-b")).toBe(
      "website-lead-alert-ack:company-b",
    );
  });
});
