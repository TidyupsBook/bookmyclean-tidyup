---
name: Live-call capture is one person's entitlement
description: Taking a booking off a live call is owner-only; what has to happen the moment that access goes away.
---

# Live-call booking is an entitlement, not a screen

Turning a call into a booking is the owner's job. The two draft endpoints (the
completed-call read and the microphone text read) refuse everyone else, and
every control that leads to them is positively gated on the owner role —
positively, so a role that is still loading shows nothing rather than a button
the server will refuse.

**Why:** the capture session lives above the router and outlives any page, so
role gating that only hides UI leaves a running microphone and in-flight
requests behind under an identity that is no longer allowed to hear the call.

**How to apply:** when the entitlement goes away mid-session, actively
(a) end the capture session, (b) stop feeding it the call-watcher side effect
that would otherwise judge every call "over" from an empty list, (c) drop
in-flight scan results instead of applying them, and (d) clear the
call-derived form state and its highlights. Green boxes are a claim that this
person was entitled to hear those words.

Fields filled from a call stay lit green for the life of the form (the running
answer to "did it get all of it?"), with a short pulse only on the one that
just landed — mid-call it is the movement that catches the eye.
