import { beforeEach, describe, expect, it } from "vitest";
import { allowRequest, resetRateLimits } from "./rateLimit";

const OPTS = { limit: 3, windowMs: 60_000 };
const T0 = Date.parse("2026-08-07T12:00:00Z");

describe("allowRequest", () => {
  beforeEach(() => resetRateLimits());

  it("allows up to the limit and then refuses", () => {
    expect(allowRequest("a", OPTS, T0)).toBe(true);
    expect(allowRequest("a", OPTS, T0)).toBe(true);
    expect(allowRequest("a", OPTS, T0)).toBe(true);
    expect(allowRequest("a", OPTS, T0)).toBe(false);
  });

  it("counts each caller separately", () => {
    for (let i = 0; i < 3; i++) allowRequest("a", OPTS, T0);
    // One person hammering the endpoint must not lock out the rest of the
    // office — that would turn a spend guard into an outage.
    expect(allowRequest("b", OPTS, T0)).toBe(true);
  });

  it("lets a refused caller through again in the next window", () => {
    for (let i = 0; i < 3; i++) allowRequest("a", OPTS, T0);
    expect(allowRequest("a", OPTS, T0)).toBe(false);
    expect(allowRequest("a", OPTS, T0 + 60_001)).toBe(true);
  });
});
