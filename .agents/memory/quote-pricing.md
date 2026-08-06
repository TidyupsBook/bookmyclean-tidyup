---
name: Quote pricing rules
description: How cleaning quotes are priced, why sent quotes are frozen, and why money rounding here can't use toFixed or Math.round alone.
---

# Quotes are derived, except once they're sent

Quote totals are computed on read from the booking's stored pricing *inputs*
(hours, crew label, hourly rate, fuel, discount, referral source) plus the
company's current rates — they are not stored.

**Why:** storing a total lets a rate change leave a quote disagreeing with
itself; storing only the inputs means the dispatcher's live preview and the
customer's texted message are always the same arithmetic.

**The exception, and it matters:** once a quote has actually been texted, the
totals are snapshotted onto the booking. A sent price is a promise. Without the
snapshot, an owner editing their tax rate silently repriced quotes customers had
already agreed to, and the dashboard showed a number the customer had never
seen. The dashboard shows the promised price as the headline and flags the
current price beside it when the two have diverged, because the correct remedy
is to send an updated quote, not to quietly change the number.

**How to apply:** anything that adds a new pricing input must (a) be stored on
the booking, (b) feed the shared pricing package rather than being recomputed
locally, and (c) be included in the send-time snapshot. Never display a derived
total for a booking that already has a sent snapshot.

# The text must quote the price that gets frozen

The quote SMS is freely editable before sending, but the snapshot taken at send
time is the *calculated* price, not whatever number is in the text. So the
message body and the snapshot must agree: sending is refused (both in the dialog
and again on the server) when the body no longer contains the calculated
figure, unless the dispatcher explicitly confirms the mismatch.

**Why:** a hand-edited discount promised the customer one figure while the
dashboard recorded another, and nobody found out until the crew arrived.

**How to apply:** the "which figure counts" rule — deposit when there is one,
otherwise the total — lives in the shared pricing package alongside the matcher,
so client warning and server refusal can never disagree. Any change to how the
draft leads with money must move that anchor rule too.

# Money rounding

Neither obvious rounding approach is correct here:

- `Math.round(x * 100) / 100` rounds half toward +infinity, so it mishandles
  negative values — and discount lines are negative.
- `.toFixed(2)` looks decimal but rounds the underlying binary double. A value
  the owner typed as `2.675` is held as `2.67499999999999982...` and rounds
  *down*, putting the texted total a cent below the printed estimate.

**Why:** the owner's quotes are compared against real printed estimates, so a
one-cent drift is a visible error, not a rounding detail.

**How to apply:** scale to cents, nudge by a small relative epsilon to undo the
binary representation error, then round away from zero. Keep the pricing package
dependency-free — it is imported by both the API and the browser.

# Where the maths lives

One shared workspace package owns the formula, imported by the API server, the
dashboard, and the db schema (for the snapshot type). Adding it as a dependency
of another workspace package needs both the `workspace:*` entry in its
package.json and a TypeScript project reference, or `tsc --build` fails while
the editor looks fine.
