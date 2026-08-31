---
name: Jobber-form leads
description: Behavioral rules for Jobber form enquiries entering the Leads inbox, and why leads win over the request-sync booking import.
---

Jobber-form enquiries reach the Leads inbox by two doors — the signed
REQUEST_CREATE webhook and a bounded newest-first sweep — both feeding one
idempotent import, so neither door can duplicate the other.

**Leads win for brand-new Jobber requests.** The pre-existing request pull
also imports open requests (as pending bookings); unreconciled, one enquiry
becomes both. Resolution: the pull skips any request that already has a
jobber-origin lead (any status — a dismissed enquiry stays dismissed), and
the sweep runs before the pull each cycle. A request already on a booking
always beats a lead.

**Why:** enquiries must be triaged in one inbox; a silently-created pending
booking skips triage and collides with converting the lead.

**How to apply:**
- Converting a jobber lead attaches to Jobber's existing client/request and
  never pushes back; an untouched pending twin booking is cancelled AND
  hands over its request id (the unique column has no status predicate, so
  cancelling alone still blocks the handover).
- The echo guard against our own pushed requests is two-sided by design —
  each side compensates after its own durable write; one side alone leaves
  an interleaving that boomerangs a lead.
- Jobber sends no delivery id: claim identity is built from the event, and
  the lead's per-company external-id uniqueness is the backstop for replays
  that differ superficially. A claim that never completed goes stale and is
  takeover-eligible, so a failed claim release can't lock a delivery out.
- A bounded (page-capped) sweep must read newest-first, or volume above the
  cap starves exactly the fresh misses it exists to catch.
- Webhook topics are enabled app-wide in Jobber's Developer Center, not per
  account — REQUEST_CREATE must be subscribed there or nothing fires.
