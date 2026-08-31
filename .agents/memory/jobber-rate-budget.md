---
name: Jobber rate budget
description: Why Jobber GraphQL calls get Throttled and how to size pages on a shared account.
---

Keep Jobber GraphQL pages cheap: the query cost Jobber throttles on is priced by the *requested* page sizes (outer `first` × each nested connection's `first`), not by what actually comes back.

**Why:** one Jobber account's throttle budget is shared across every poller that uses it — prod calendar sync, prod time-sheet sync, and any dev workspace pollers all drain the same bucket, so a big page gets rejected in a half-drained budget while several cheap pages slip through. There is no retry inside a sync run — a Throttled reply fails the whole cycle until the next poll.

**How to apply:** when adding or widening a Jobber query, multiply the `first` values to estimate cost and prefer more small pages over one big one (budget restores between requests). Keep the total ceiling (page size × max pages) above a busy account's real volume, because hitting the page cap silently disables reconcile-by-absence sweeps.
