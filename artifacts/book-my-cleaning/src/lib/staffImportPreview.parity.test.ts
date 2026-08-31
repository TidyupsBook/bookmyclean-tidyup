/**
 * The preview half of the import-parity contract.
 *
 * The API server's `src/lib/staffImportParityFixtures.ts` states the
 * `/team/import` matching rule as data, and its `team.importParity.test.ts`
 * proves the live endpoint obeys it. This suite runs the SAME cases through
 * the Paste List preview, so the "New" / "Updates <name>" labels the owner
 * sees are pinned to what the server will actually do. If either copy of the
 * rule drifts, its suite fails on the same named case.
 */
import { describe, expect, it } from "vitest";
import type { TeamMember, TeamMemberInput } from "@workspace/api-client-react";
import { previewImport } from "./staffImportPreview";
import {
  IMPORT_PARITY_CASES,
  type ParityMember,
} from "../../../api-server/src/lib/staffImportParityFixtures";

/** The preview only reads name and email; everything else is scenery. */
function asTeamMember(member: ParityMember, id: number): TeamMember {
  return {
    id,
    name: member.name,
    email: member.email,
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
  } as TeamMember;
}

describe("import parity: the preview predicts rows exactly as the fixtures promise", () => {
  for (const fixture of IMPORT_PARITY_CASES) {
    it(fixture.title, () => {
      const keyById = new Map<number, string>();
      const team = fixture.roster.map((member, i) => {
        keyById.set(i + 1, member.key);
        return asTeamMember(member, i + 1);
      });

      const rows: TeamMemberInput[] = fixture.rows.map((row) => ({
        name: row.name,
        email: row.email,
        phone: null,
        role: "cleaner",
        isLead: false,
        active: true,
        homeAddress: null,
      }));

      const out = previewImport(team, rows);

      for (const [rowIndex, row] of fixture.rows.entries()) {
        const got = out[rowIndex]!;
        const label = `${fixture.title}: row ${rowIndex + 1} ("${row.name.trim()}")`;

        const expectedOutcome =
          row.expected.kind === "update" ? "update" : row.expected.kind;
        expect(
          got.outcome,
          `${label} — the preview's label diverges from what the server actually does (see the API server's team.importParity.test.ts, which pins the server to these same fixtures)`,
        ).toBe(expectedOutcome);

        if (row.expected.kind === "update") {
          expect(
            got.existing && keyById.get(got.existing.id),
            `${label} — the preview says "Updates" but names the WRONG existing member`,
          ).toBe(row.expected.memberKey);
        } else {
          expect(
            got.existing,
            `${label} — the preview should not name an existing member here`,
          ).toBeNull();
        }
      }
    });
  }
});
