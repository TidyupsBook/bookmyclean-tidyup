---
name: Read watermarks and unread counts
description: Why "mark read" must be anchored to a message id, not to a timestamp or to now()
---

When clearing unread state, never stamp `now()` and never write back a
timestamp that has been read out of the row in application code. Mark read up
to the id of the newest message actually returned, and let the database read
that row's own `created_at`.

**Why:** two separate failures.

1. Postgres timestamps keep microseconds; a JS `Date` only keeps milliseconds.
   A timestamp round-tripped through the app is a few microseconds EARLIER than
   the stored value, so the last message stays "newer than the watermark" and
   the thread never clears. This looks like the update silently doing nothing.
2. `now()` (or a wall-clock read) also swallows anything committed between the
   read of the messages and the write of the watermark — the recipient never
   sees a message that was marked read on their behalf.

The same shape applies to counter-based unread state: clear only the count
observed at read time (`greatest(unread - observed, 0)`), never set it to 0.

**How to apply:** any "opening this marks it read" endpoint. For an empty
thread there is no message id, so pin a timestamp taken BEFORE the read and use
that. Always move the watermark forward only (`greatest(...)`), so two devices
reading at once cannot wind it back.
