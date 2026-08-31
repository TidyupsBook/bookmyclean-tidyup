---
name: Owed-text queue (pending_texts)
description: General retry queue for texts the app owes someone; claim-by-delete, re-insert on failure, swept hourly.
---

Texts earned by a state change (join-request nudges/verdicts) are recorded in the
`pending_texts` table, already composed (final content, final recipient), so a retry
needs nothing from the moment that created them — the row they were about may be gone
(a declined join request's seat is deleted).

Delivery claims the row by deleting it, sends over the platform Quo workspace, and
re-inserts on failed/skipped. The hourly Quo health check sweeps the whole table for
every company, not just Quo-connected ones. `toPhone: null` means "the owner", resolved
at send time so a text queued before the owner fixed their number still lands.

**Why:** the retry state must live apart from the state change (an approval must hold
even when the "you're in" text fails), and delete-claim gives one sender under
concurrency without a marker column per message kind.

**How to apply:** new "the app owes someone a text" features should queue via
`queueText` rather than fire-and-forget `sendMessage`; tests that create companies and
hit these flows must clean `pending_texts` before deleting the company (FK), since the
platform key is absent/skipped in tests and rows stay pending.

**Test flake:** vitest runs files in parallel against the shared dev DB, and the sweep (`retryPendingTexts`) is global claim-by-delete — a concurrent sweep in another test file can claim a company's pending row between insert and assert. A pending-row assertion failing only in the full run is this race, not a regression.
