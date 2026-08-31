---
name: Quo contact identity claims
description: Durable concurrency and identity-handoff rules for mirroring local clients and callers into Quo contacts.
---

Quo contact lookup followed by create must be guarded by a durable per-identity claim. Historical backfills and overlapping webhook states can otherwise create the same remote contact more than once.

**Why:** One external caller can be processed many times concurrently, and a stable external ID does not make a client-side lookup-then-create sequence atomic.

**How to apply:** Suppress per-record remote work during bulk rebuilds, sync each rebuilt identity once, and retain a database-backed retry window for normal concurrent deliveries.

When a caller’s Quo contact is adopted by a known client, changing or removing the client’s phone must detach the old caller from that shared remote contact before the client contact is updated.

**Why:** Otherwise the client and a later call from the old number alternately overwrite one Quo contact with different phone numbers.

**How to apply:** Clear the old caller’s remote-contact linkage during identity separation so a later call can establish an independent caller contact.