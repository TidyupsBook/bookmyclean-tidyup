import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JobberTaxConfigurationError,
  verifyJobberTaxConfiguration,
} from "./jobber";

describe("Jobber invoice tax configuration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts exactly one 12.5% account tax", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: { account: { taxRates: { nodes: [{ rate: 12.5 }] } } },
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(
      verifyJobberTaxConfiguration("test-token"),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["no tax", []],
    ["the wrong rate", [{ rate: 13 }]],
    ["multiple rates", [{ rate: 12.5 }, { rate: 5 }]],
  ])("rejects %s before invoice creation", async (_label, nodes) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ data: { account: { taxRates: { nodes } } } }),
            { status: 200 },
          ),
      ),
    );

    await expect(verifyJobberTaxConfiguration("test-token")).rejects.toThrow(
      JobberTaxConfigurationError,
    );
  });
});
