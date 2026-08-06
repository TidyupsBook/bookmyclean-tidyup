---
name: Webhook idempotency via claim rows
description: The pattern for making signed third-party webhook deliveries exactly-once, and why acknowledging before processing loses data.
---

## Rule

For inbound provider webhooks, insert the provider's delivery id into a table
with a unique constraint **before** doing the work:

1. `INSERT ... ON CONFLICT DO NOTHING RETURNING id`. No row back means this
   delivery was already handled — return 200 immediately, do nothing else.
2. Do the actual processing inside the request, not after responding.
3. On success return 2xx. On failure **delete the claim row** and return 5xx so
   the provider's retry is treated as fresh rather than swallowed as a duplicate.

**Why:** the tempting shape is "verify signature, return 202, process in the
background." That looks responsive but any failure after the acknowledgement is
invisible — the provider considers the event delivered and never retries, so the
event is gone. A timestamp window alone also does not stop replay: a captured
delivery can be resent repeatedly inside the window and each copy is processed.
The claim row solves replay and retry-duplication with the same mechanism.

**How to apply:** whenever adding a webhook receiver that mutates state. The
processing must be fast enough to fit the provider's delivery timeout — a couple
of API round-trips is fine; anything genuinely long-running needs a real queue,
where the claim row is written first and the queue job is the retry unit.

## Related guard

Match the event to the tenant *and* verify the event's resource actually belongs
to that tenant. Deriving the company from the signing key alone is not enough
when one provider workspace can host resources for several tenants.
