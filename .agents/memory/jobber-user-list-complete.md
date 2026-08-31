---
name: Jobber user list is complete by contract
description: Absence from listJobberUsers means "deactivated in Jobber" to callers, so the listing must paginate to exhaustion and fail loudly rather than return a partial page.
---

# Jobber active-user list

The Team page (and anything judging a stored `jobber_user_id` link) reads
absence from the active-user list as "their Jobber account is gone" and offers
a destructive Unlink. That makes the list's completeness a correctness
contract, not an optimization.

**Why:** Jobber's GraphQL `users` query is cursor-paginated; a bare
`first: 100` silently truncates larger teams, which would falsely flag active
staff as deactivated.

**How to apply:** any listing whose ABSENCE is treated as evidence must
paginate to exhaustion, and when it cannot finish (page cap, missing cursor)
it must throw instead of returning what it gathered. Test pagination by
stubbing `fetch`, not our helpers.
