---
name: Clerk ids do not survive a database copy between instances
description: Why a cloned production database strands every account, and the rule for any email-based recovery path built to fix it
---

A database seeded from another environment carries Clerk user ids that were
issued by *that* environment's Clerk instance. Development and production are
separate instances with separate id spaces, so every copied `owner_user_id` and
`clerk_user_id` resolves to a 404 in the new one.

Nothing errors. The rows look fine, the app looks fine, and the only symptom is
that real users are treated as brand-new: they sign in, match nothing, get
routed to onboarding, and create duplicate empty companies beside their real
data — every time, forever. Diagnose it by taking an id straight from the
database and asking the *target* instance for it.

**Why it hides:** an unrecognized account is indistinguishable from a new one.
Any "no company → onboarding" redirect turns this into an infinite loop that
looks like a UI bug.

**How to apply:** store a human-stable handle (a verified email) next to every
Clerk id that grants access, so identity can survive its login. Never rely on
the id alone.

## The rule for recovery paths

Re-attaching a record to someone whose verified email matches, once the stored
account 404s, is the right repair — but it must never be left standing open.
A verified email proves who someone is *today*, not that they are the person
who held the record. Addresses get shared within a business, handed to a
successor, or released and re-registered by a stranger.

**Why:** without a fence, "delete the old account, then verify the old address"
is a route into another tenant's company. A code review caught exactly this.

**How to apply:** scope recovery to the affected cohort with an explicit
expiring window column, set by the repair migration. Records created normally
get no window. A genuinely deleted owner is a support task, not self-service.
Require all of: window open, email verified, holder confirmed gone (404 only —
a timeout or rate limit is "unknown", not "gone"), and a compare-and-swap
pinned on the old id. An "unknown" answer must also skip any negative cache,
or an outage locks the rightful owner out long after it ends.
