---
name: Deploy boot must be loud and fast
description: Why a publish can fail with zero log output, and the startup rules that keep it diagnosable
---

A publish fails if the container does not open its configured port within roughly
one minute. When the API's first action is a database call, a database that is
slow, locked, or briefly unreachable produces a deploy that dies with **no log
output whatsoever** — the build logs stop at "Creating Autoscale service" and the
runtime logs show only repeated healthcheck 500s and "required port was never
opened". Nothing points at the cause.

Rules for anything on the boot path:

- **Log before the first database call.** A line printed before any I/O is the
  difference between "module loading failed" and "the database did not answer".
- **Nothing but migrations may block `listen()`.** Third-party setup (Stripe
  webhook registration, backfills) and background loops belong *inside* the
  listen callback. An outside API having a slow minute must never be the reason
  a release fails to ship.
- **Bound every wait.** The pg pool needs `connectionTimeoutMillis`; the
  migration session needs `lock_timeout` (a publish can be applying a schema
  diff to the same database while the new container boots) and a retry around
  connect. An error in the log beats an unbounded hang.
- **`SET` on a pooled client leaks.** Releasing a client returns the same
  session to the pool, so migration timeouts must be `RESET` in `finally`, and
  the connection destroyed (`release(true)`) if the reset itself fails.

**Why:** a failed publish left the previous build serving and gave no clue what
went wrong; the whole diagnosis had to come from timestamps and absence of logs.

**How to apply:** when touching `index.ts` startup order, migrations, or the
shared pool, keep the boot path to log → migrate → listen → everything else.

## The cause it eventually surfaced

Postgres `28000` with *"The endpoint has been disabled. Enable it using the API
and retry"* means the **production database is paused**, not that credentials
are wrong. The published app keeps serving from the already-running revision,
so the only visible symptom is publishes that die at startup. Fix is in the
Database pane (select the database, "Unpause database"); a user-set
`DATABASE_URL` secret overriding the platform one produces the same error with
no unpause button. Retrying connects does not help — the endpoint stays off
until someone enables it.
