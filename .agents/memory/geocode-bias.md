---
name: Geocoding must be biased to the service area
description: Why address lookups send a bias point, and what that does to the shared cache
---

A bare street line ("17115 61 Ave") is a perfectly good address in several provinces
and states at once. Google does not return an error for the ambiguity — it returns the
wrong one, with full confidence, and the cleaner is suddenly 3,000 km from the job.

So any lookup made on behalf of a company sends a `bounds` box around the area that
company already works in, derived from what is already on its map. `bounds` biases
rather than restricts, which is the behaviour wanted: local streets win, but an address
genuinely somewhere else still resolves for the person who deliberately searched it.

**Why:** a home address on a staff card silently landed ~10 km out, and the same class
of mistake at continental scale is invisible in the UI — a distance ranking simply puts
that person last forever and nobody knows why.

**How to apply:** whenever a bias is added to a geocode call, it must also become part
of the cache key, or two companies share one answer for the same street text. Round the
bias coarsely into the key so a whole neighbourhood still shares a single paid lookup.

Related: any endpoint that turns user input into a billed third-party call needs a
per-user ceiling. The concurrency semaphore in the geocoder is not one — its waiter
queue is unbounded, so it paces spend rather than capping it.
