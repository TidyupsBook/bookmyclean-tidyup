---
name: Cancellation sweeps need proof of a complete pull
description: When an inbound sync marks local rows canceled because they were missing from a remote pull, the sweep must be gated on the pull being provably complete — not merely on "no exception was thrown".
---

An inbound sync that reconciles by absence ("this booking is no longer in
their calendar, so cancel it") is only correct if the pull it compares against
is the remote's complete inventory for the window. Any pull that ended early —
a page returned without its payload, a response missing its pagination block, a
page ceiling reached, a partial retry — makes "missing from the pull"
indistinguishable from "we never asked". Treating the two the same cancels real
work.

The rule: carry an explicit completeness flag through the fetch loop, set it
false on *every* early exit, and run the sweep only when it is still true. A
`break` inside a pagination loop is the classic offender — it looks like "no
more pages" at the call site and silently becomes "the remote has nothing".

**Why:** a defensive `if (!page) break` was written when the sync window was
sixty days, where a bad page could only mis-cancel a couple of months. Widening
the window turned the same line into something that would wipe a company's
entire calendar in one cycle. The blast radius of a reconcile-by-absence bug
scales with the window, so widening a sync window is never just a constant
change — re-audit every path that can end the pull early.

**How to apply:** whenever changing a sync window, page ceiling, or pagination
loop, find the sweep/reconcile step and enumerate the ways the pull can finish
short. Cover each with a test that asserts *zero* cancellations, not just that
the happy path still works.
