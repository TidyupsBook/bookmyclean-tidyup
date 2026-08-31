---
name: Lead Jobber push & adoption
description: Website-form leads push themselves into Jobber on submit; the behavioral rules that keep one enquiry from becoming two Jobber records.
---

# Lead Jobber push & adoption

Website-form and ad-sheet leads are pushed into Jobber (new client + property
 + work request) after their app record is durable; the sheet importer schedules
new rows without waiting for Jobber. **Why:** the owner's CRM ingests enquiries
*from* Jobber, so an unconverted lead that never reaches Jobber is invisible to
it.

**Durable decisions:**

- A lead is ALWAYS a new Jobber client — never matched by phone. A silent
  merge onto an existing customer can't be seen or undone; two visible
  clients can be merged inside Jobber. The only client ever reused is the
  one a previous attempt at the same lead created — and recovering that
  orphan requires durable evidence of a prior attempt plus an exact
  field-for-field double with zero requests on it, never a plain search hit.
- "We pushed this to Jobber" and "we imported this from Jobber" must be
  separate state (`source` is the discriminator on shared id columns) —
  conflating them blocks quoting/scheduling or triggers cancel sweeps.
- The customer never waits on Jobber: push after durable save,
  fire-and-forget, failures recorded on the lead and retried by the office.

**Duplication invariants (all are needed):**

1. A booking wearing the lead's id owns the sync from the moment it exists;
   the lead push stands down on booking-exists, not on status.
2. The queued push judges the row at run time, never the caller's snapshot.
3. Every state write is conditioned on still holding the claim; an attempt
   that outlives its lease stops at the next checkpoint and archives what it
   created after losing the claim (but never archives a recovered orphan —
   the winner is entitled to find it).
4. After an uncertain outcome, reconcile against Jobber before creating:
   any request on the lead's own client is adopted, and a client that is an
   exact double with no requests is finished, not re-created.
5. Our own pushes fire Jobber's REQUEST_CREATE webhook too, so echo removal
   must be two-sided: the importer skips ids our pushes recorded, and each
   push deletes any Jobber-origin echo lead after recording its id.

**How to apply:** any new path that sends a lead (or something derived from
one) into Jobber must reuse stored ids, respect the claim, and reconcile
with Jobber rather than re-create after an uncertain outcome; any new path
that imports Jobber requests must first prove the request is not our own.
