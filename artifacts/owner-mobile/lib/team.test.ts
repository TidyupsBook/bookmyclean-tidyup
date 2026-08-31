import { describe, expect, it } from "vitest";
import {
  defaultChoiceFor,
  roleChoiceOf,
  roleChoicesFor,
  roleFields,
  roleLabel,
  selfRosterMemberId,
} from "./team";

describe("roleFields", () => {
  it("maps lead to a cleaner seat with the lead label", () => {
    expect(roleFields("lead")).toEqual({ role: "cleaner", isLead: true });
  });

  it("never sends isLead alongside dispatcher", () => {
    expect(roleFields("dispatcher")).toEqual({
      role: "dispatcher",
      isLead: false,
    });
  });

  it("maps cleaner plainly", () => {
    expect(roleFields("cleaner")).toEqual({ role: "cleaner", isLead: false });
  });
});

describe("roleChoicesFor", () => {
  it("only an owner may hand out a dispatcher seat", () => {
    expect(roleChoicesFor("owner")).toContain("dispatcher");
    expect(roleChoicesFor("dispatcher")).not.toContain("dispatcher");
    expect(roleChoicesFor(undefined)).not.toContain("dispatcher");
  });
});

describe("defaultChoiceFor", () => {
  it("starts at what the applicant asked for", () => {
    expect(
      defaultChoiceFor({ role: "dispatcher", isLead: false }, "owner"),
    ).toBe("dispatcher");
    expect(defaultChoiceFor({ role: "cleaner", isLead: true }, "owner")).toBe(
      "lead",
    );
  });

  it("clamps a dispatcher ask when the approver can't grant it", () => {
    expect(
      defaultChoiceFor({ role: "dispatcher", isLead: false }, "dispatcher"),
    ).toBe("cleaner");
  });
});

describe("selfRosterMemberId", () => {
  const roster = [
    { id: 7, role: "owner" },
    { id: 9, role: "dispatcher" },
    { id: 11, role: "cleaner" },
  ];

  it("finds the owner's card by role — /me reports teamMemberId null for owners", () => {
    expect(
      selfRosterMemberId({ role: "owner", teamMemberId: null }, roster),
    ).toBe(7);
  });

  it("uses the reported seat id for a dispatcher", () => {
    expect(
      selfRosterMemberId({ role: "dispatcher", teamMemberId: 9 }, roster),
    ).toBe(9);
  });

  it("uses the reported seat id for a cleaner — self-rename is allowed", () => {
    expect(
      selfRosterMemberId({ role: "cleaner", teamMemberId: 11 }, roster),
    ).toBe(11);
  });

  it("handles a missing profile or an empty roster without crashing", () => {
    expect(selfRosterMemberId(undefined, roster)).toBeNull();
    expect(
      selfRosterMemberId({ role: "owner", teamMemberId: null }, []),
    ).toBeNull();
    expect(
      selfRosterMemberId({ role: "dispatcher", teamMemberId: null }, roster),
    ).toBeNull();
  });
});

describe("roleChoiceOf / roleLabel", () => {
  it("round-trips the three spoken roles", () => {
    expect(roleChoiceOf({ role: "cleaner", isLead: true })).toBe("lead");
    expect(roleLabel({ role: "cleaner", isLead: true })).toBe("Lead Cleaner");
    expect(roleLabel({ role: "owner", isLead: false })).toBe("Owner");
  });
});
