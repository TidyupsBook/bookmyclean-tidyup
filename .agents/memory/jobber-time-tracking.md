---
name: Jobber time tracking is read-only
description: Why clocked on-site time reaches Jobber as a job note, and how Jobber's own timers are pulled back in
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

## The inbound direction

Reading time sheets *is* allowed: `Job.timeSheetEntries` (and a top-level
`timeSheetEntries`, whose `targetItem` is often a Visit rather than a Job, so the
per-job field is the easier join). The developer app's Timesheets section offers
only a Read checkbox — no Write exists to tick — and reading worked on a
connected account whose section toggle was on, so do not assume a reconnect is
needed before trying.

**Rule:** an imported stretch is stored with its Jobber entry id in a column
distinct from the outbound note id, and the outbound push returns early when
that id is set.

**Why:** one column for both directions would post Jobber's own hours back to
Jobber as a note, so the same hour sits in their file twice and the office bills
it twice.

**How to apply:** ignore `ticking` entries — an open timer pulled from elsewhere
fights the app's "one running clock per booking" rule. Never overwrite a stretch
the office corrected by hand. Page the *nested* entries connection too; a per-job
cap silently drops billable hours rather than failing.
