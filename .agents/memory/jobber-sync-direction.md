---
name: Jobber sync runs in two directions
description: Why imported Jobber jobs are tagged with their own column, and what the pull is allowed to touch
---

# Jobber sync runs in two directions

Two independent syncs exist and they must never write to each other's rows:

- **Outbound (push):** a booking we took is pushed to Jobber as a *work
  request*. The Jobber request id is stored in the booking's `jobberJobId`.
- **Inbound (pull):** scheduled Jobber *jobs/visits* are imported as bookings.
  The Jobber ids are stored in separate columns, and only rows carrying them
  may be updated or cancelled by the pull. The same rule holds per object
  kind: inbound requests and quotes each have their own `jobberSynced*Id`
  column, never keyed on the push's `jobberJobId`/`jobberQuoteId`.

**Why:** the two id spaces are different objects in Jobber (requests vs jobs).
Reusing one column would let the calendar pull decide a receptionist-taken
booking had "disappeared from Jobber" and cancel it.

**How to apply:**
- Any new Jobber read path filters on the inbound column, never on
  `jobberJobId` or `jobberSynced`.
- The cancellation sweep marks rows cancelled, never deletes — deposits and
  history hang off those bookings.
- Skip the sweep when pagination was cut short; an incomplete job list looks
  identical to "everything was cancelled".
- Jobber retires pinned GraphQL versions and renames filter fields between
  them, so every sync 404s or errors at once. A blanket Jobber failure means
  check the pinned version before suspecting the code; bumping it also means
  re-verifying the filter shapes, which change between versions.
- Inbound pending imports (requests/quotes) also stamp the push-owned columns
  (`jobberQuoteId`, links) so accept-and-assign can schedule from the real
  Jobber quote and the push refuses duplicates — but any "did WE push this?"
  check must run AFTER the "did we import this?" check, since imported rows
  wear both ids. Their pending rows use `scheduledFor = import time`, or the
  Bookings history floor hides old-but-open work.
- Imported addresses get coordinates from the normal geocode backfill, not from
  the sync. Changing an imported address must null out lat/lng/geocodedAt, or
  the map keeps pointing crews at the customer's previous house.
