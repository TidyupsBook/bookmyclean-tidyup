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
