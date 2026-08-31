import type { TeamMember, TeamMemberInput } from "@workspace/api-client-react";

/**
 * Predict what the server's `/team/import` will do with each pasted row.
 *
 * This mirrors the handler's matching rule exactly, because the preview's
 * whole job is to be true before a roster-changing submit:
 * - a row with an email matches only by that email;
 * - a row without one falls back to name, but only against existing members
 *   who themselves have NO email, and only when exactly one such member
 *   answers to the name. A same-named member who has an email is not a
 *   match — the server would add a new person, so the preview must say "New".
 */
export function buildImportMatcher(
  roster: TeamMember[],
): (row: TeamMemberInput) => TeamMember | null {
  const byEmail = new Map<string, TeamMember>();
  for (const m of roster) {
    if (m.email) byEmail.set(m.email.trim().toLowerCase(), m);
  }

  const emailless = roster.filter((m) => !m.email);
  const nameCounts = new Map<string, number>();
  for (const m of emailless) {
    const key = m.name.trim().toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  const byName = new Map<string, TeamMember>();
  for (const m of emailless) {
    const key = m.name.trim().toLowerCase();
    if (nameCounts.get(key) === 1) byName.set(key, m);
  }

  return (row) => {
    const email = (row.email ?? "").trim().toLowerCase();
    if (email) return byEmail.get(email) ?? null;
    return byName.get(row.name.trim().toLowerCase()) ?? null;
  };
}

export type ImportRowPreview = {
  row: TeamMemberInput;
  /**
   * What the server will do with this row: create a member, update the one
   * named, skip it because an earlier row in the same paste already claimed
   * the same identity (same email, or same name with no email), or skip it
   * as invalid because the name is blank — the server refuses such a row
   * with an error, so the preview must never promise "New" for it.
   */
  outcome: "new" | "update" | "duplicate" | "invalid";
  existing: TeamMember | null;
};

/**
 * Predict the whole submission, not just row-by-row matching. The server
 * processes rows in order and skips any later row that repeats an identity
 * already seen in the same upload, so the preview must too — otherwise two
 * rows for one person would both promise to land.
 *
 * `team` must be the complete team list (pending members included); the
 * server matches against every member of the company, not just the roster
 * the page happens to show.
 */
export function previewImport(
  team: TeamMember[],
  rows: TeamMemberInput[],
): ImportRowPreview[] {
  const matchOf = buildImportMatcher(team);
  const seen = new Set<string>();
  return rows.map((row) => {
    // The server skips a blank-name row outright (even one carrying an
    // email), and it never claims an identity — so it can't make a later
    // row look like a duplicate, and it must never be labeled "New".
    if (row.name.trim().length === 0) {
      return { row, outcome: "invalid", existing: null };
    }
    const email = (row.email ?? "").trim().toLowerCase();
    const key = email
      ? `email:${email}`
      : `name:${row.name.trim().toLowerCase()}`;
    if (seen.has(key)) return { row, outcome: "duplicate", existing: null };
    seen.add(key);
    const existing = matchOf(row);
    return { row, outcome: existing ? "update" : "new", existing };
  });
}
