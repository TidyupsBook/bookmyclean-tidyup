import { describe, expect, it } from "vitest";
import {
  isLeadsSyncStale,
  LEADS_SYNC_STALE_AFTER_MS,
  leadKey,
} from "./leadsSync";

/**
 * Pins which sheet rows count as leads. The gate matters in both directions:
 * the owner hand-types walk-in/referral leads that carry only a name and an
 * address (no phone, no email, no export id) and those must import, while
 * header echoes and footer rows polled from arbitrary tabs must stay out.
 */
describe("leadKey", () => {
  it("keys a hand-typed row that has only a name and address", () => {
    const key = leadKey({
      first_name: "sara",
      last_name: "chags",
      "how_many_bedrooms_do_you_have.?": "3",
      street_address: "4470 Prowse Road SW, Edmonton. unit 63",
    });
    expect(key).toMatch(/^fp_/);
  });

  it("keys a row with only a phone number (existing behavior)", () => {
    expect(leadKey({ phone_number: "780-555-0100" })).toMatch(/^fp_/);
  });

  it("skips a lone name with no other lead detail", () => {
    // A note or a staff-list entry sitting under a name column on some
    // other polled tab must not become a lead.
    expect(leadKey({ first_name: "notes only" })).toBe(null);
    expect(leadKey({ first_name: "Pat", last_name: "Smith" })).toBe(null);
  });

  it("prefers the sheet's own id over a fingerprint", () => {
    expect(leadKey({ id: "l:123", first_name: "Sam" })).toBe("l:123");
  });

  it("two name-only leads at different addresses get different keys", () => {
    const a = leadKey({ first_name: "Pat", street_address: "1 First St" });
    const b = leadKey({ first_name: "Pat", street_address: "2 Second St" });
    expect(a).not.toBe(b);
  });

  it("skips blank padding rows", () => {
    expect(leadKey({ first_name: "", phone_number: " ", email: "" })).toBe(
      null,
    );
  });

  it("skips a duplicated header row (every cell echoes its column name)", () => {
    expect(
      leadKey({
        id: "id",
        first_name: "First_Name",
        last_name: "last_name",
        phone_number: "phone_number",
      }),
    ).toBe(null);
  });

  it("skips footer rows that carry no contact handle", () => {
    expect(leadKey({ campaign_name: "Total: 27" })).toBe(null);
  });
});

describe("lead sync freshness", () => {
  it("flags a missing or three-window-old poll as stale", () => {
    const now = Date.UTC(2026, 7, 29, 19, 30);
    expect(isLeadsSyncStale(null, now)).toBe(true);
    expect(
      isLeadsSyncStale(new Date(now - LEADS_SYNC_STALE_AFTER_MS - 1), now),
    ).toBe(true);
  });

  it("keeps a recent poll healthy", () => {
    const now = Date.UTC(2026, 7, 29, 19, 30);
    expect(
      isLeadsSyncStale(new Date(now - LEADS_SYNC_STALE_AFTER_MS), now),
    ).toBe(false);
  });
});
