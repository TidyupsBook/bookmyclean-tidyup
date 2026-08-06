---
name: Customer-facing quote link
description: Why the quote page is unauthenticated, how the token is the authorisation, and the send-path invariants that keep the link alive.
---

# The quote link is a bearer link, by necessity

A customer receives a short SMS and taps a link. They have no account and never
will, so the quote page is public and the random token in the URL *is* the
authorisation.

**Why:** any auth gate here kills the feature — the person deciding whether to
book is standing in their kitchen with a text message, not signing in.

**How to apply:** two places must stay unauthenticated, and both are easy to
break by accident:

1. **Express** — the public router must not apply `requireAuth`. Clerk's
   middleware only *establishes* context globally; it does not reject, so
   mounting a router without `requireAuth` is sufficient. Do not "tidy up" by
   hoisting a global `requireAuth`.
2. **The SPA** — the route must sit outside the signed-in guards. A public route
   nested inside them redirects the customer to sign-in and the feature is dead.

Consequences accepted deliberately:
- The response must carry only that one customer's own estimate. Never widen it
  to anything company-wide or anything keyed by a guessable id.
- Invalid and non-existent tokens must return the *same* 404, so the endpoint
  can't be used to probe which tokens are live.
- The link does not expire. Same behaviour as Jobber's own client hub, and the
  blast radius is one customer's own estimate plus the ability to approve their
  own job.

# Approval must be claimed in the database, not read-then-written

Approve is idempotent via a conditional update guarded on the timestamp still
being null, and the feed entry is only written by the update that won.

**Why:** phones prefetch links and customers double-tap. A read-then-write check
lets two simultaneous requests both see "not approved yet", both write, and both
post to the dispatcher's feed.

# A hand-edited SMS must not lose the link

Dispatchers can edit the draft text freely before sending. The send path checks
the outgoing message still contains the quote URL and re-appends it if not, then
stores the repaired text as the record of what was sent.

**Why:** an edit that trims the bottom off the message would otherwise text the
customer a quote they have no way to read or approve.

# The token is minted lazily and then never changes

Minted on first preview or send rather than backfilled onto every booking, and
reused forever after.

**Why:** a link already sitting in a customer's phone has to keep working.

# The page shows the frozen price when one exists

Prefer the sent-totals snapshot over recomputing from current settings.

**Why:** this is the page the customer was *sent to*. It must show the price
they were promised even after the company edits its rates. See
[quote-pricing](quote-pricing.md).
