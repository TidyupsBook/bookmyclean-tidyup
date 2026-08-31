---
name: Lead-origin bookings in Jobber
description: Why a booking carries its own lead-origin marker, why it is set at creation, and why it has no foreign key.
---

A booking that came out of the Leads inbox must always become a **new** Jobber
client. It must never be matched onto an existing client by phone number, which
is what ordinary bookings do (and should keep doing, so repeat customers don't
duplicate).

**Why:** the owner wants merges to happen inside Jobber, where a merge is
visible and reversible. A silent phone match is neither, and it fires on the
automatic push before anyone has seen the booking.

**How to apply:**

- The origin marker lives on the booking, set **at creation**, not by the
  follow-up convert call. Booking creation kicks off the Jobber push
  immediately, so anything learned after the 201 is already too late for the
  push that matters. Any new client flow that creates a booking from a lead
  must send the origin with the create call.
- The marker deliberately carries **no foreign key**. It is a historical fact
  ("this customer arrived from an ad"), not a live relationship. `ON DELETE SET
  NULL` would erase it when the inbox is tidied and quietly return the booking
  to phone matching on a later manual re-send; `ON DELETE RESTRICT` would make
  a future lead purge fail inside a migration and take a publish down. A
  dangling id is the smaller problem, and the create route already proves the
  lead belongs to the caller's company before storing it.
- The convert endpoint backfills the marker when it is still empty, which only
  helps a later retry — it cannot undo a match the automatic push already made.
  An outdated mobile build that creates lead bookings without the marker will
  still phone-match on its first push.
