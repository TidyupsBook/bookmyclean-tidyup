---
name: Background sweep event dedupe
description: How server-side sweeps that raise once-per-event user-visible rows must handle restarts, overlaps, multiple processes, and write failures.
---

A periodic sweep that emits once-per-slip (or once-per-event) rows needs four layers:

1. **In-process**: an in-flight guard on the cycle plus per-tenant promise chaining, so an overlapping sweep never reads not-yet-advanced state.
2. **Restart**: re-seed "already announced" state from the day's own emitted rows before the first sweep, so a redeploy mid-event doesn't re-announce.
3. **Cross-process (durable)**: a plain SELECT-then-INSERT in a transaction is NOT atomic across DB clients — take a `pg_advisory_xact_lock` keyed on the event inside the transaction before the check (or use a unique constraint). Prove it with real concurrent transactions against the dev DB; an in-memory mock cannot validate the race.
4. **Write failure**: only mark an event as announced once its row is durably inserted (or confirmed already present). If the insert throws, revert the in-memory "announced" mark so the next sweep retries — otherwise a transient DB error silences the alert for the whole event.

**Why:** each missing layer produces a user-visible bug — duplicate alerts (1–3) or permanently lost alerts (4) — under conditions (slow cycles, redeploys, second process, transient DB errors) that are invisible in happy-path testing.

**How to apply:** any new periodic sweep that writes activity/notification rows.
