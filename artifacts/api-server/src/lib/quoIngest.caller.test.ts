import { describe, expect, it } from "vitest";
import type { QuoCall } from "./quo";
import { callerNumberOf, directoryCallerNumberOf } from "./quoIngest";

function call(
  direction: QuoCall["direction"],
  participants: string[],
): QuoCall {
  return {
    id: "call-1",
    phoneNumberId: "line-1",
    direction,
    participants,
    status: "completed",
    createdAt: "2026-08-28T12:00:00.000Z",
  };
}

describe("Quo caller selection", () => {
  const owned = new Set(["+1 (403) 555-0100"]);

  it("keeps the external participant and rejects labels and company numbers", () => {
    expect(
      callerNumberOf(
        call("incoming", ["Unknown", "+14035550100", "+1 780 555 0199"]),
        owned,
      ),
    ).toBe("+1 780 555 0199");
    expect(
      callerNumberOf(call("incoming", ["Anonymous", "+14035550100"]), owned),
    ).toBeNull();
  });

  it("does not create caller-directory identities from outgoing recipients", () => {
    expect(
      directoryCallerNumberOf(
        call("outgoing", ["+14035550100", "+17805550199"]),
        owned,
      ),
    ).toBeNull();
  });
});
