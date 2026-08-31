---
name: Mobile live call capture
description: Phone-side listen-to-this-call decisions — shared extraction, Expo Go degradation, entitlement cleanup, and native recognizer retirement.
---

# Mobile live call capture

- Extraction rules never fork onto the client: the phone posts raw transcript
  text to the same server draft endpoint the web uses.
- Importing `expo-speech-recognition` crashes Expo Go (native module resolved
  at module scope). Lazy-require it and surface a named "needs the installed
  app build" state — never a dead button. Real-device testing needs a dev build.
- Call-filled form values carry provenance: typing into a box takes ownership
  of it. On entitlement loss, clear only still-call-derived values (and the
  exact note lines the call added) — those are PII the person is no longer
  entitled to hold, while owner-typed values must survive.
- Async scan answers must apply through a ref to the latest render's applier;
  a mutation onSuccess captured at schedule time reads stale boxes and
  overwrites what the owner typed in the meantime.
- Once live access has been observed, an *unknown* current-user answer
  (sign-out, failed /me refresh) fails closed like an explicit "no": stop the
  mic, invalidate scans, clear call-derived values. Only pre-first-access
  loading may be treated as "still waiting".

**Why:** resetting only the highlight markers (or ignoring the unknown state)
leaves extracted name/phone/address submittable — or a hidden microphone
running — after a mid-session downgrade.

## Native recognizer retirement crosses screen lifetimes

Native speech events belong to the module, not the React hook that started
them. After `abort()`, the old recognizer can deliver its terminal error/end
after the booking form unmounts and remounts. A new hook must not start another
run until that old terminal event has been consumed.

**Why:** hook-local cancellation refs disappear on unmount. A late old event can
otherwise stop the new session or schedule a duplicate restart.

**How to apply:** keep retirement ownership above hook lifetime, queue a
user-requested restart until the retiring end event finishes dispatching, cancel
that queue if its new owner unmounts, and release the barrier if abort throws.
