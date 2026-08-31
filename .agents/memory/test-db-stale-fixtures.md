---
name: Test DB stale fixtures
description: API tests share the dev database; crashed runs leave rows that break later runs on unique constraints.
---

API-server tests run against the live dev database and clean up in `afterAll`. Two failure modes compound:

- A new migration (e.g. a new table) only applies when the API server workflow restarts — until then, any test touching the new table crashes in setup/teardown.
- When teardown crashes partway, fixture rows with **hardcoded unique values** (e.g. a company `join_code`) survive, and every later run fails on the unique constraint (23505) even after the original cause is fixed.

Also: test files that call **global sweeps** (e.g. the pending-texts retry) race each other under parallel file execution — one file's sweep claims another file's fixture row across companies. The api-server vitest config sets `fileParallelism: false` for this reason; keep it, and don't assume a random single-test pass means the suite is race-free.

**How to apply:** if `test-api` fails on a table that "does not exist" (42P01), restart the API server workflow to apply migrations, then look for leftover fixture rows (query by the fixture's hardcoded unique value) and delete them with `psql "$DATABASE_URL"` before re-running. Prefer run-unique values in new fixtures.

**42703 "column does not exist" in api tests** means the shared dev DB is behind the checked-out schema (a merged task added a column and post-merge sync did not run here). Fix: `pnpm --filter db run push-force`, then re-run — a server restart alone may not apply it.
