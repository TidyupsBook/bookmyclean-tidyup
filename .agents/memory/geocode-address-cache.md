---
name: Geocode by address, not by row
description: Why the geocoding backfill dedupes on a normalized address in a shared table, caches misses as well as hits, and is deliberately not company-scoped.
---

Geocoding is billed per lookup, and this domain is repeat business: a season of
imported jobs is hundreds of bookings across a few dozen houses. Resolving
row-by-row pays for the same house every week forever.

The design:

- Work is grouped by **normalized address**, and one lookup fans out to every
  booking sharing it. Cost is bounded by distinct places, not visits, and it is
  effectively a one-time charge per address.
- Results live in a table keyed on the normalized address, holding **nullable**
  coordinates so *misses are cached too*. Without that, an unresolvable address
  (a typo, or a note where a street should be) is retried every cycle forever
  and starves the budget. Misses get a TTL — typos do eventually get fixed.
- The table is **global, not company-scoped**. An address resolves to the same
  point regardless of who cleans there, and two companies working the same city
  should not each pay for the same street. Nothing customer-identifying is
  stored — an address string and a coordinate.
- The per-cycle budget is rotated through the unresolved queue rather than
  always starting at the head, so a few addresses failing for reasons that
  aren't cached (network blips) can't permanently block everything behind them.

**Why:** the original backfill did a fixed small batch of *bookings*, ordered by
future date only. Past work never got pinned at all, and a bulk import would
have trickled onto the map over hours while re-billing the same addresses.

**How to apply:** any new source of bookings (imports, bulk entry) should rely
on this backfill rather than geocoding inline. When testing it, remember the
cache is a real shared table that survives across test runs — fixtures need
run-unique addresses or the lookup under assertion never happens.
