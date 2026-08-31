/**
 * The "did it get all of it?" signal. The owner takes bookings while the
 * customer is still talking, so what the call captured has to be visible
 * without reading a word: green where it landed, a pulse on the one that just
 * arrived. These pin both halves — a filled box that quietly stopped lighting
 * up would look fine in a screenshot and cost him a re-ask on the phone.
 */
import { describe, expect, it } from "vitest";
import { fieldHighlightClass } from "./callFillHighlight";

const none = new Set<string>();

describe("filled-box highlight", () => {
  it("leaves a box the call never touched alone", () => {
    expect(fieldHighlightClass(none, none, "phone")).toBeUndefined();
  });

  it("lights a filled box green and keeps it lit after the pulse ends", () => {
    const filled = new Set(["phone"]);
    const settled = fieldHighlightClass(filled, none, "phone");
    expect(settled).toContain("ring-emerald-400/70");
    expect(settled).not.toContain("animate-pulse");
  });

  it("pulses only the box that just landed", () => {
    const filled = new Set(["phone", "city"]);
    const justFilled = new Set(["city"]);
    expect(fieldHighlightClass(filled, justFilled, "city")).toContain(
      "animate-pulse",
    );
    expect(fieldHighlightClass(filled, justFilled, "phone")).not.toContain(
      "animate-pulse",
    );
  });

  it("never pulses a box that isn't filled in", () => {
    expect(
      fieldHighlightClass(none, new Set(["city"]), "city"),
    ).toBeUndefined();
  });

  it("keeps the contents readable by highlighting only the outline", () => {
    const filled = new Set(["phone"]);
    const settled = fieldHighlightClass(filled, none, "phone");
    const pulsing = fieldHighlightClass(filled, filled, "phone");
    for (const cls of [settled, pulsing]) {
      expect(cls).toContain("border-emerald-400");
      expect(cls).toContain("ring-emerald-400/70");
      expect(cls).toContain("text-foreground");
      expect(cls).not.toMatch(/\bbg-emerald-/);
    }
  });
});
