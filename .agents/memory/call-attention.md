---
name: Call attention seen-set & corner ownership
description: How "this call still needs booking" is tracked and which floating control owns the bottom-right corner.
---

## The shared attention store (`callAttention.ts`)

The Calls page "New" markers and the floating Live booking launcher read one
store; neither keeps its own tally.

- **Waiting** = incoming, ended without booking (`completed`/`missed`), and not
  in the per-identity seen-set. No expiry timer — the flag clears only when
  someone engages (opens the call's detail, or the desk with `?callId=`) or the
  call's own status flips to `booked`.
- **Why:** the old five-minute announcement window is fine for a toast, but a
  call that needs booking stays true until acted on; timers and reloads were
  silently absolving calls.
- The seen-set persists in localStorage per `email@company` identity (shared
  machines / colliding call ids across companies). First prime marks all
  already-finished calls seen — history is not news — but deliberately leaves a
  currently-ringing call unseen so it waits once it ends. Marks made before the
  prime are buffered, not written: a store born with one id treats all history
  as news.
- **How to apply:** any new surface that says "this call needs you" must read
  `callsAwaitingBooking`/`useCallAttention`, and any new "someone engaged"
  path must call `markCallSeen` — never invent a parallel tally or timer.

## Corner ownership (`cornerStack.ts`)

One owner at a time for the bottom-right corner: live-call bar (mic running,
permission tap, actionable decline) > Live booking launcher > nothing; the
back-to-top button never owns it — it queues one step above the launcher and
hides under the bar.

- **Why `unsupported` declines don't raise the bar:** on an iPad every single
  ring sets `declined: "unsupported"`, which would park the mic bar over the
  launcher forever on exactly the device the launcher exists for. The
  launcher's waiting state *is* the unsupported browser's path.
- **How to apply:** new floating corner pieces must consult
  `useCornerOwner`/`liveCallBarBusy` rather than adding another `fixed
  bottom-4 right-4` element; the launcher never starts the microphone itself
  (the app-wide watcher already auto-starts capture where it can).
