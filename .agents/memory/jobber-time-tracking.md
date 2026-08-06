---
name: Jobber time tracking is read-only
description: Why clocked on-site time reaches Jobber as a job note instead of a time sheet entry
---

Jobber's GraphQL API exposes `TimeSheetEntry` as a **readable type only**. Live
introspection against a connected production account found no `timeSheet*`
mutation and no `TimeSheetEntryCreateInput`. There is no way to write hours into
Jobber's own timer.

**Rule:** clocked time is pushed as a *note* on the Jobber record — `jobCreateNote`
for jobs pulled from their calendar, `noteCreate` with `subjectType: REQUEST` for
work requests this app created. Best effort: a Jobber outage must never block a
cleaner from clocking off, so failures are stored on the time entry, not thrown.

**Why:** the clock is this app's record of truth for billing; Jobber only needs
to *see* the hours when the office builds the invoice.

**How to apply:** before promising any Jobber write feature, introspect the live
schema — the docs and general knowledge overstate what their API accepts. A note
needs no extra OAuth scope, so do not tell the user to reconnect for one.
