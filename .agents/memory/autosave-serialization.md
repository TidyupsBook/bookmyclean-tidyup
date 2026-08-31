---
name: Autosave must serialize writes
description: Debounced autosave fields need one-in-flight write serialization, not just stale-callback guards
---

Debounced autosave (notes pads etc.) must never have two writes in flight at once. Keep a single in-flight marker; when a save settles, re-send the latest draft if it still differs from the last confirmed save.

**Why:** overlapping PATCHes can commit on the server in reverse order — the DB ends on stale text while the UI says "Saved". A client-side sequence/stale-callback guard alone only fixes the status line, not the persisted data; code review rejected that approach.

**How to apply:** any new autosave surface (web or mobile): serialize writes, chain the newest draft on settle (success *and* error — but only surface an error if the failed text is still what's on screen), and flush at unmount by deferring to the in-flight settle rather than firing a parallel request. Test with a mock that models last-write-wins server persistence.
