---
name: Shared detail-cache merges
description: When two mutations both return the same detail object, each must merge only its own field into the React Query cache.
---

**Rule:** When multiple mutations (e.g. a notes autosave and a tag toggle on the same call) each return the full detail object, their `onSuccess` handlers must merge only the field they own into the cached detail (`setQueryData` with an updater spreading `old`), never write the whole response.

**Why:** A slow save of one field settles after a save of another field and its response snapshot carries the *older* value of the other field — writing the full response silently rolls the fresher field back. Caught by architect review on the call notes/tag pair; the UI then disagrees with the list and the next tap does the opposite of what the owner intended.

**How to apply:** Any time a second mutation is added against an endpoint whose detail response is already written into the cache by an existing mutation, convert BOTH to field-scoped merges and add an out-of-order test (start save A, land save B in the cache, then deliver A's late response and assert B's field survived).
