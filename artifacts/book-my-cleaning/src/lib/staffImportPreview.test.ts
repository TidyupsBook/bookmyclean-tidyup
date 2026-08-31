import { describe, expect, it } from "vitest";
import type { TeamMember, TeamMemberInput } from "@workspace/api-client-react";
import { buildImportMatcher, previewImport } from "./staffImportPreview";

/**
 * The preview must predict exactly what the server's import handler does:
 * email rows match by email only; email-less rows fall back to name, but
 * only against existing members who themselves have no email, and only when
 * the name is unambiguous among those.
 */

function member(overrides: Partial<TeamMember> & { id: number }): TeamMember {
  return {
    name: "Someone",
    email: null,
    phone: null,
    role: "cleaner",
    isLead: false,
    active: true,
    color: null,
    homeAddress: null,
    homeLat: null,
    homeLng: null,
    status: "active",
    hasLogin: false,
    inviteEmailSent: false,
    blockedByOtherCompany: false,
    claimedAt: null,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  } as TeamMember;
}

function row(overrides: Partial<TeamMemberInput>): TeamMemberInput {
  return {
    name: "Someone",
    email: null,
    phone: null,
    role: "cleaner",
    isLead: false,
    active: true,
    homeAddress: null,
    ...overrides,
  };
}

describe("buildImportMatcher", () => {
  it("matches a row with an email by email, case-insensitively", () => {
    const jane = member({ id: 1, name: "Jane", email: "jane@example.com" });
    const match = buildImportMatcher([jane]);
    expect(match(row({ name: "J. Doe", email: "JANE@example.com" }))).toBe(
      jane,
    );
    expect(match(row({ name: "Jane", email: "other@example.com" }))).toBeNull();
  });

  it("does NOT name-match a same-named member who has an email (server would add)", () => {
    const jane = member({ id: 1, name: "Jane", email: "jane@example.com" });
    const match = buildImportMatcher([jane]);
    // No email on the pasted row: the server only falls back to email-less
    // members, so this is a new person — the preview must say "New" too.
    expect(match(row({ name: "Jane" }))).toBeNull();
  });

  it("name-matches a unique email-less member", () => {
    const sam = member({ id: 2, name: "Sam Lee" });
    const match = buildImportMatcher([
      sam,
      member({ id: 1, name: "Jane", email: "jane@example.com" }),
    ]);
    expect(match(row({ name: "  sam lee " }))).toBe(sam);
  });

  it("refuses to name-match when two email-less members share the name", () => {
    const match = buildImportMatcher([
      member({ id: 1, name: "Alex Smith" }),
      member({ id: 2, name: "Alex Smith" }),
    ]);
    expect(match(row({ name: "Alex Smith" }))).toBeNull();
  });
});

describe("previewImport", () => {
  it("marks later rows with a repeated identity as duplicates, like the server", () => {
    const out = previewImport(
      [],
      [
        row({ name: "Jane", email: "jane@example.com" }),
        row({ name: "Jane D.", email: "JANE@example.com" }),
        row({ name: "Sam Lee" }),
        row({ name: " sam lee " }),
      ],
    );
    expect(out.map((p) => p.outcome)).toEqual([
      "new",
      "duplicate",
      "new",
      "duplicate",
    ]);
  });

  it("matches against pending members too — the server sees the whole team", () => {
    const pendingJane = member({
      id: 3,
      name: "Jane",
      email: "jane@example.com",
      status: "pending",
    });
    const out = previewImport(
      [pendingJane],
      [row({ name: "Jane", email: "jane@example.com" })],
    );
    expect(out[0]!.outcome).toBe("update");
    expect(out[0]!.existing).toBe(pendingJane);
  });
});
