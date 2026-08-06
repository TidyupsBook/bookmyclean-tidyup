/**
 * The price-in-the-text matcher, locked in.
 *
 * The send-quote guard depends on `messageContainsQuotePrice` recognising the
 * calculated price inside free text the dispatcher may have hand-edited. These
 * tests pin the accepted spellings ("$150", "$150.00", "$1,500.00"), the
 * near-misses that must NOT count ("$1500.75" when the price is $150), and the
 * deposit-versus-total anchor rule — so a future tweak to the draft wording or
 * money formatting cannot silently stop the warning firing.
 */
import { describe, expect, it } from "vitest";
import { messageContainsQuotePrice, quotedPriceAnchor } from "./index";

describe("quotedPriceAnchor", () => {
  it("leads with the deposit when there is one", () => {
    expect(quotedPriceAnchor({ total: 200, deposit: 50 })).toBe(50);
  });

  it("falls back to the total when the deposit is waived", () => {
    expect(quotedPriceAnchor({ total: 168.75, deposit: 0 })).toBe(168.75);
  });

  it("is null when nothing has been priced", () => {
    expect(quotedPriceAnchor({ total: 0, deposit: 0 })).toBeNull();
  });
});

describe("messageContainsQuotePrice", () => {
  const totals = (total: number, deposit = 0) => ({ total, deposit });

  it("is vacuously true when nothing has been priced", () => {
    expect(messageContainsQuotePrice("Quote coming soon!", totals(0))).toBe(
      true,
    );
  });

  describe("whole-dollar amounts", () => {
    const t = totals(150);

    it("accepts the bare dollar form", () => {
      expect(messageContainsQuotePrice("Your total is $150 today", t)).toBe(
        true,
      );
    });

    it("accepts the cents form", () => {
      expect(messageContainsQuotePrice("Your total is $150.00", t)).toBe(true);
    });

    it("accepts the amount at the very end of the message", () => {
      expect(messageContainsQuotePrice("Your total is $150", t)).toBe(true);
    });

    it("accepts the amount followed by sentence punctuation", () => {
      expect(messageContainsQuotePrice("It comes to $150. Thanks!", t)).toBe(
        true,
      );
    });

    it("rejects a longer amount that merely starts with the price", () => {
      expect(messageContainsQuotePrice("Your total is $1500", t)).toBe(false);
    });

    it("rejects different cents on the same dollars", () => {
      expect(messageContainsQuotePrice("Your total is $150.75", t)).toBe(false);
    });

    it("rejects the classic near-miss: $1500.75 when the price is $150", () => {
      expect(messageContainsQuotePrice("Your total is $1500.75", t)).toBe(
        false,
      );
    });

    it("rejects a message with no dollar figure at all", () => {
      expect(
        messageContainsQuotePrice("Hey! Here is your estimate link.", t),
      ).toBe(false);
    });

    it("finds a real match after an earlier near-miss", () => {
      expect(
        messageContainsQuotePrice("Was $1500, now just $150 for you", t),
      ).toBe(true);
    });
  });

  describe("amounts with cents", () => {
    const t = totals(168.75);

    it("accepts the exact-cents form", () => {
      expect(messageContainsQuotePrice("That's $168.75 all in", t)).toBe(true);
    });

    it("does not accept the truncated whole-dollar form", () => {
      expect(messageContainsQuotePrice("That's $168 all in", t)).toBe(false);
    });

    it("matches to the cent, not approximately", () => {
      expect(messageContainsQuotePrice("That's $168.74 all in", t)).toBe(false);
    });
  });

  describe("thousands", () => {
    const t = totals(1500);

    it("accepts the comma form with cents", () => {
      expect(messageContainsQuotePrice("Quote: $1,500.00", t)).toBe(true);
    });

    it("accepts the comma form without cents", () => {
      expect(messageContainsQuotePrice("Quote: $1,500", t)).toBe(true);
    });

    it("accepts the plain form without a comma", () => {
      expect(messageContainsQuotePrice("Quote: $1500", t)).toBe(true);
    });

    it("rejects a longer run of digits", () => {
      expect(messageContainsQuotePrice("Quote: $15000", t)).toBe(false);
    });
  });

  describe("deposit-versus-total anchor rule", () => {
    it("anchors on the deposit when there is one — the total alone is not enough", () => {
      const t = totals(200, 50);
      expect(messageContainsQuotePrice("Deposit: $50 to book", t)).toBe(true);
      expect(messageContainsQuotePrice("Your total is $200", t)).toBe(false);
    });

    it("anchors on the total when the deposit is waived", () => {
      const t = totals(200, 0);
      expect(messageContainsQuotePrice("Your total is $200", t)).toBe(true);
      expect(messageContainsQuotePrice("Deposit: $50 to book", t)).toBe(false);
    });
  });
});
