---
name: Repairing production rows through a migration
description: Guard rules and replay trick for migrations that delete or rewrite live data
---

Production is read-only from the workspace (writes roll back), so every repair
to live data has to ship as a migration applied at API startup. That makes the
migration file the only chance to get it right.

**Guard rules for a destructive one:**

- Pin the specific row ids *and* an independent attribute (owner id, etc.), *and*
  require the emptiness/safety condition outright. Owner id alone matches any
  future row created under the same live account.
- Repeat the guard verbatim on each statement, child tables first. A
  data-modifying CTE does not guarantee ordering between the child and parent
  deletes. Check that deleting the children cannot change which parents match.
- Enumerate every table carrying the scoping column before writing the deletes
  (`select table_name from information_schema.columns where column_name='company_id'`).
  A single missed non-cascading FK child makes the migration fail against the
  one database it exists to repair, and it will never have failed in development.

**Test it for real.** Seed fixtures in development at the *same ids* as the
production rows, including one that must survive, then restart and check both
outcomes. This is the only honest verification available, since the migration is
otherwise a no-op locally.

**Replaying a corrected migration:** drizzle applies entries whose journal `when`
exceeds the last applied timestamp, so bumping `when` on an already-applied file
makes the fixed version run again in development. Safe only if the statements are
idempotent — which a guarded repair should be anyway.
