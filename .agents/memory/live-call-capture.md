---
name: Live call capture (browser mic transcription)
description: Rules for the app-wide Web Speech session that types a ringing call into the booking form — where it must be mounted, how starts are cancelled, and which failures must be named.
---

# Live call capture

Quo gives no live audio, so "live transcription" is always the dispatcher's own
microphone on speakerphone via the browser's Web Speech API. Post-call Quo
transcripts are a separate, later path.

## The session must live above the router

**Why:** pages render `AppLayout` themselves, so a provider mounted *inside*
the layout is invisible to the hooks in the page component — the page is the
layout's parent, not its child. Mounting it there also tears the session down
on every navigation, losing a call already being transcribed.

**How to apply:** anything that must survive navigation (a capture session, a
long-lived timer keyed to something happening off-screen) goes above `<Switch>`
in `App.tsx`. Consumers get `null` outside it; give them an inert fallback
object rather than throwing, so a page can still render standalone in a test.

## Every async start needs a cancellation token

**Why:** asking for the microphone is asynchronous. A Stop pressed — or a
hangup detected — while the permission check is in flight is otherwise
overtaken by its own answer, and the microphone comes on *because* the person
switched it off. Same shape in the permission pre-check that decides whether an
automatic start is allowed.

**How to apply:** bump a ref on anything that countermands a start (stop,
unmount, a competing start), capture it before the await, and bail if it moved.

## Never auto-start a permission prompt

Only start on our own initiative when the permission is already `granted`
(`navigator.permissions.query`). A prompt raised out of nowhere, mid-call, on a
page nobody is looking at, gets the site permanently blocked in Chrome — and a
blocked site can never listen again. Surface a "press this once" state instead.

## A thrown `start()` must drop the instance

**Why:** holding a dead recognition object makes the "already running" guard
bail out on every later press, so the button goes dead for the rest of the
session with no error anywhere.

Related: `onstart` is the only true "listening" signal — `start()` returning
just means the request was accepted.

## Name the failure, or it looks broken

"Microphone on, no words" has several unrelated causes (denied permission, no
input device, Chrome unable to reach its speech service, caller not on
speaker). Map every error code to a plain sentence with the fix in it, and add
a watchdog for "listening but nothing heard" — silence with no explanation is
indistinguishable from a broken feature, and it is the complaint that actually
arrives.

## Poll ownership and hangups

Two components share the calls query and each disables its own poll when it
thinks the other is watching. Whenever a mic session is following a call, one
of them must keep polling regardless of that arrangement — the hangup is what
releases the microphone, and a cached `in_progress` row keeps it open forever.

## Alert channels are not interchangeable

A toast reaches someone watching the app, a sound reaches someone looking away,
a desktop pop-up reaches someone in another window. Suppressing a channel
because a page shows the same information must suppress *only* the toast.
Desktop pop-ups fire solely while `document.hidden` (otherwise they duplicate
the toast) and only from a click-triggered permission request.

**Claim before the async check:** an automatic start must record which call it is for *before* awaiting the permission query — otherwise a hangup during the check has nothing to cancel and the late answer switches the mic on unwatched. Denied permission must release the claim.

## An end is not news; only a fatal cause may end the session

A speech session has to outlast a whole phone call, so the default answer to
"recognition stopped" is to reopen it, not to report it. Chrome ends
recognition after every lull, `start()` throws when a reopen races the
outgoing instance, and the speech service blips with `network` — none of those
mean the dispatcher is finished. Reopen on a backoff whose first rung is zero
(so natural restarts leave no gap), keep the accumulated transcript across
every reopen, and name the trouble on screen only after it has failed a couple
of times in a row.

Only a permanently fatal cause may end the session outright and clear the call
claim: permission denied, no input device, no speech pack, unsupported
browser. Releasing the claim on any error is what turned one hiccup into "press
Start again".

**Why:** the two mechanisms that used to kill live transcription were an
over-eager error path and an over-trusted call status; both were "correct"
in isolation and useless together.

**How to apply:** classify every error code fatal/transient before acting on
it, route every ending through one place (the end handler, never the error
handler), guard against a stale instance's late end reopening a second
session, and keep the abandoned-microphone guarantee as a silence watchdog
inside the session rather than as an external stop.

## The provider's call status is advisory

A telephony provider moves a call off "in progress" while the two people are
still talking. Anything that follows a call — a microphone, a timer, a badge —
may *say* the call looks finished, and must never act on it by stopping work
the dispatcher started.

**Why:** a false hangup mid-sentence costs a booking; a stale "still live"
note costs nothing.

**How to apply:** turn the watcher into a note plus a Stop button, and keep
the poll that feeds it running for as long as the session is open — including
on pages that normally stand aside to avoid double-polling.

## Wiping the words is a generation, not a state reset

Clearing the transcript must bump a counter that every in-flight scan carries
a copy of, and a returning scan whose copy is stale drops its answer.

**Why:** reading a transcript is a server round trip, so the previous caller's
answer routinely arrives after the desk has been cleared for the next one —
the exact thing clearing exists to prevent.

**How to apply:** capture the counter inside the mutation function (not in the
component body), compare on success, and bump it wherever the words on screen
stop matching what a scan was asked about.
