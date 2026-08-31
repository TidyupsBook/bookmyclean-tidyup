---
name: This project needs real migration files, not just drizzle-kit push
description: Schema changes must ship a migration file plus a journal entry, because the API applies migrations at startup.
---

Every schema change must ship **both**: the Drizzle schema edit *and* an additive migration
file in `lib/db/migrations` with a matching `meta/_journal.json` entry. Running
`drizzle-kit push` is only half the job.

**Why:** the API server runs Drizzle's `migrate()` at startup, before accepting traffic.
`push` mutates the *development* database directly and writes no migration file, so a column
added that way exists in dev and is simply absent everywhere else — the deployed app then
fails on the first query touching it. The generic advice that "Replit diffs dev against
production on publish, so migration scripts are forbidden" does **not** apply here: this repl
has deliberate startup-migration infrastructure, and that infrastructure wins. A code review
flagging "missing migration" on this project is correct, not a false positive.

**How to apply:** follow the existing files' style — plain `ADD COLUMN IF NOT EXISTS` (and
`CREATE TABLE IF NOT EXISTS`) so the script is idempotent on any prior database state,
because only the initial `CREATE TABLE` migration is ever baselined. Then actually prove it:
drop the new columns from the dev database, restart the API, and confirm startup puts them
back with the right defaults. Pushing to dev and eyeballing the schema tests nothing.

## Killed publish can half-apply a migration
A publish SIGKILLed during startup migrations can leave the DDL applied but the drizzle tracking row missing. Every later boot re-runs the migration, hits "already exists", and crashes with zero logs (pino worker-thread logs are lost on instant crash).
**Why:** happened when an ALTER TABLE waited on locks from the old deployment, publish timed out at 60s, and the ALTER committed after the kill.
**How to apply:** write DDL migrations idempotent (`IF NOT EXISTS`); when a publish fails silently after a schema change, compare prod vs dev `drizzle.__drizzle_migrations` counts. Prod SQL is read-only, so the fix is editing the unapplied migration file, not inserting the tracking row.

## Two more paths that re-run already-applied DDL
Task agents share the dev database: their migration applies there under the branch's own
number, then the merge renumbers the file (new tag + journal `when`), so main's next boot
re-runs the same DDL against a database that already has it. Separately, Publish diffs the
dev schema into production *before* the app boots there, so prod already has the new columns
while prod's `__drizzle_migrations` is still behind — boot then re-runs them.
**Why:** three non-idempotent ALTERs crash-looped dev boot after a task merge and killed a
publish at promote (api port never opened, healthcheck 500s, "not all artifact ports opened").
**How to apply:** the `IF NOT EXISTS` rule has no exceptions, including "obviously fresh"
columns; after any task merge that adds a migration, restart the API and confirm
"Migrations complete" before suggesting a publish.
