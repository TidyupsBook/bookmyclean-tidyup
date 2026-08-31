---
name: Work this app pushes onto the Jobber calendar
description: Why app-created Jobber ids must be separate from imported ones, and why the remote system is the only reliable duplicate guard.
---

**Ids for work this app creates in Jobber must be stored apart from the ids
that mark a row as imported from Jobber.**

**Why:** two rules read them and want opposite answers. The outbound push
refuses to touch anything that came from Jobber, so recording a job we created
in the imported-id columns makes the app disown its own work. But the inbound
pull meets that same job on its next run, and if it can't recognise it the
owner ends up with two of every clean.

**How to apply:** on the pull, adopt the matching row (conditional claim, then
fill in the imported ids) instead of inserting. Adoption must not overwrite
what the office typed with the emptier values the remote returns.

**A local claim row is not an idempotency guarantee across a remote
mutation.** Between "the remote created it" and "we recorded it" the process
can die, the write can fail, or another attempt can take the claim — and the
identifier is then lost while the work exists out there. So: ask the remote
whether it already made this thing (a quote knows its jobs) before creating
one, and never discard an id it just handed back. Prove it by wiping the
stored ids and retrying, asserting the create mutation is not called again.
