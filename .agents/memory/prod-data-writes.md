---
name: Production data writes
description: How to get rows into the live database when the SQL tool is read-only in production
---

Production SQL through the agent's database tooling is **read-only** — an INSERT/UPDATE
there fails with `cannot execute INSERT in a read-only transaction`. Development SQL
is unrestricted, so a change that works in dev cannot simply be repeated against prod.

**Why:** the live database holds real customer and staff records; the tooling refuses
writes rather than trusting a query to be scoped correctly.

**How to apply:** when the user wants data (not schema) in the live app, drive it
through the app's own authenticated endpoint or UI — the same path a human owner
would use. Prepare whatever file or payload that path accepts, hand it over, and say
which button to press. Never treat "publish" as a way to move data: each environment
keeps its own database, so publishing ships code only and the live rows stay as they
were.

Schema is the exception: migrations run at API startup, so a shipped migration file
does reach production on its own.
