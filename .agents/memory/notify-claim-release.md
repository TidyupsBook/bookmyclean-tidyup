---
name: Quo owner-notify pending marker
description: Outage/recovery texts are decoupled from the health flag via a pending-notification marker; the flag never reverts for send failures.
---

The Quo health flag (`quoNeedsReauth`) flips on the claimed transition and **stays** —
it never reverts because a notification failed. The owed text is recorded in a separate
`quoNotifyPending` marker ("dead" | "restored" | null) written in the same conditional
UPDATE that claims the flag transition.

Delivery uses a second claim: conditionally clear the marker, send, and on failure/skip
restore it — guarded on BOTH the slot still being empty AND the health flag still
matching the notification kind, so a stale failed send can't re-arm an obsolete text
after a newer opposite transition already sent.

**Why:** releasing the flag claim on send failure made the dashboard show Quo as healthy
(up to an hour) while the key was dead; and an unguarded restore raced with opposite
transitions to text owners obsolete outage/recovery messages.

**How to apply:** the hourly health check retries the pending marker for *every* company
each pass (including the undecryptable-key branch — don't `continue` past the retry).
Skipped-for-config sends also keep the marker, so the text goes out once config is fixed.
