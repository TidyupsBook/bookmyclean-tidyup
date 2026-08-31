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
- Also enumerate the complete foreign-key graph, including indirect references
  between scoped tables. Cross-scope `SET NULL` and `CASCADE` edges are more
  dangerous than blocking FKs because they can silently alter protected rows
  while leaving row counts unchanged.
- Persist the approved digest, actor, exact targets, and before/after snapshots
  in a global immutable audit row inside the destructive transaction. The audit
  must not have a foreign key to any row the repair deletes.

**Why:** Scope-column counts alone cannot reveal every delete blocker or silent
cross-company mutation, and a successful API response is not durable evidence
of an irreversible production repair.

**How to apply:** Lock every table participating in the FK graph, reject
target-to-protected edges before mutation, delete in child-first graph order,
and commit the independent audit record atomically with the repair.

**Test it for real.** Seed fixtures in development at the *same ids* as the
production rows, including one that must survive, then restart and check both
outcomes. This is the only honest verification available, since the migration is
otherwise a no-op locally.

**Replaying a corrected migration:** drizzle applies entries whose journal `when`
exceeds the last applied timestamp, so bumping `when` on an already-applied file
makes the fixed version run again in development. Safe only if the statements are
idempotent — which a guarded repair should be anyway.
