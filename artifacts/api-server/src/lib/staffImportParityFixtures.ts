/**
 * Shared fixtures pinning the import matching rule in BOTH places it lives:
 * the server's `/team/import` handler (routes/team.ts) and the Paste List
 * preview (book-my-cleaning/src/lib/staffImportPreview.ts).
 *
 * The rule, stated once:
 * - a row with an email matches only by that email (trimmed, case-folded);
 * - a row without one falls back to name, but only against existing members
 *   who themselves have NO email, and only when exactly one such member
 *   answers to the (trimmed, case-folded) name;
 * - within one paste, a later row repeating an identity already seen (same
 *   email, or same name for email-less rows) is skipped, not applied.
 *
 * Two test suites consume these cases: `routes/team.importParity.test.ts`
 * runs each one through the live import endpoint, and the web app's
 * `staffImportPreview.parity.test.ts` runs each through the preview. If
 * either side drifts from the rule above, its suite fails on the same named
 * case — so a change to one copy of the rule cannot land quietly.
 *
 * Deliberately import-free so both workspaces can consume it as plain data.
 */

/** An existing member of the company before the paste. */
export type ParityMember = {
  /** Stable handle the tests use to say WHICH member a row must update. */
  key: string;
  name: string;
  email: string | null;
};

export type ParityOutcome =
  /** The server creates a new member; the preview says "New". */
  | { kind: "new" }
  /** The server updates the member with this key; the preview names them. */
  | { kind: "update"; memberKey: string }
  /** The server skips the row as an in-paste repeat; the preview greys it. */
  | { kind: "duplicate" }
  /**
   * The server refuses the row with an error (blank name); the preview flags
   * it as a problem. Such a row claims no identity, so it can never make a
   * later row look like a duplicate.
   */
  | { kind: "invalid" };

export type ParityRow = {
  name: string;
  email: string | null;
  expected: ParityOutcome;
};

export type ParityCase = {
  title: string;
  roster: ParityMember[];
  rows: ParityRow[];
};

export const IMPORT_PARITY_CASES: ParityCase[] = [
  {
    title: "a row with an email matches by that email, never by name",
    roster: [{ key: "jane", name: "Jane", email: "jane@example.com" }],
    rows: [
      {
        name: "Janet Doe",
        email: "jane@example.com",
        expected: { kind: "update", memberKey: "jane" },
      },
    ],
  },
  {
    title: "email matching ignores case and surrounding whitespace",
    roster: [{ key: "mixed", name: "Mixed Case", email: "MIXED@Example.com" }],
    rows: [
      {
        name: "Mixed Case",
        email: "  mixed@EXAMPLE.com  ",
        expected: { kind: "update", memberKey: "mixed" },
      },
    ],
  },
  {
    title: "an email-less row never matches a same-named member who HAS one",
    roster: [{ key: "jane", name: "Jane", email: "jane@example.com" }],
    rows: [{ name: "Jane", email: null, expected: { kind: "new" } }],
  },
  {
    title: "a unique email-less name matches despite case and whitespace",
    roster: [
      { key: "sam", name: "Sam Lee", email: null },
      { key: "jane", name: "Jane", email: "jane@example.com" },
    ],
    rows: [
      {
        name: "  sam lee  ",
        email: null,
        expected: { kind: "update", memberKey: "sam" },
      },
    ],
  },
  {
    title: "two email-less namesakes make name-matching refuse (row is new)",
    roster: [
      { key: "alex1", name: "Alex Smith", email: null },
      { key: "alex2", name: "Alex Smith", email: null },
    ],
    rows: [{ name: "Alex Smith", email: null, expected: { kind: "new" } }],
  },
  {
    title:
      "a row carrying a NEW email is new, even over a name-matchable member",
    roster: [{ key: "sam", name: "Sam Lee", email: null }],
    rows: [
      {
        name: "Sam Lee",
        email: "sam@fresh.example.com",
        expected: { kind: "new" },
      },
    ],
  },
  {
    title:
      "a repeated email inside one paste: first row lands, second is skipped",
    roster: [{ key: "jane", name: "Jane", email: "jane@example.com" }],
    rows: [
      {
        name: "Jane",
        email: "jane@example.com",
        expected: { kind: "update", memberKey: "jane" },
      },
      {
        name: "Jane Again",
        email: "JANE@EXAMPLE.COM",
        expected: { kind: "duplicate" },
      },
    ],
  },
  {
    title: "a repeated email-less name inside one paste is skipped",
    roster: [],
    rows: [
      { name: "Fay", email: null, expected: { kind: "new" } },
      { name: "  fay ", email: null, expected: { kind: "duplicate" } },
    ],
  },
  {
    title:
      "a blank-name row is a problem, never 'New' — and claims no identity",
    roster: [{ key: "sam", name: "Sam Lee", email: null }],
    rows: [
      // Whitespace-only counts as blank, even when the row carries an email.
      {
        name: "   ",
        email: "nameless@example.com",
        expected: { kind: "invalid" },
      },
      { name: "", email: null, expected: { kind: "invalid" } },
      // A second blank row is ALSO invalid, not a duplicate of the first:
      // invalid rows never enter the seen-identity set.
      { name: "  ", email: null, expected: { kind: "invalid" } },
      // …and a real row after them still lands normally.
      {
        name: "Sam Lee",
        email: null,
        expected: { kind: "update", memberKey: "sam" },
      },
    ],
  },
];
