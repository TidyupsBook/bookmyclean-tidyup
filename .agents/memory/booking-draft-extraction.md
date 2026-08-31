---
name: Booking draft extraction stays deterministic
description: Why the "fill the form from the call" feature uses pattern matching instead of an LLM, and what it is allowed to guess.
---

Pulling booking details out of a call transcript (or a live microphone
transcript) is done with plain pattern matching. No model call.

**Why:** the dispatcher presses the fill button while the customer is still
talking, sometimes twice on the same call. They need it instant and repeatable
— the same words must produce the same boxes every time, or they stop trusting
it and retype everything. A model also adds a per-call cost and a failure mode
on the one screen that must never stall. The whole codebase has no AI
dependency; adding one here would be the first.

**How to apply:** extend the patterns, don't reach for a model. Two rules the
extraction must keep:

- It never guesses a field it cannot see in the words. City and province in
  particular are left blank rather than inferred from a postal code or an area
  code — a wrong address gets saved and dispatched to a crew, whereas a blank
  one gets asked about.
- Timing stays a phrase ("next Tuesday"), never a parsed date. Turning it into
  a real date silently books the wrong day.

On the form side, a fill only writes into boxes that are still empty, so a
re-scan can never overwrite a correction the dispatcher already typed. The
extraction runs continuously while the caller talks, so that guard has to be
checked against the *live* form values at the moment a response lands, not the
values captured when the request went out — the dispatcher types while
requests are in flight. Free-text boxes the fill appends to (crew notes) need
their own "has been hand-edited" flag; "empty only" doesn't protect them.

**The recurring bug class is a pattern that matches ordinary conversation.**
Every field added here has produced one:

- Anything anchored on "this is" / "I'm" catches "this is for my mother" and
  saves a customer called "For My". A denylist of following words can't cover
  English; require the candidate to end the thought instead.
- A pattern whose middle allows digits swallows the sentence in front of it.

Test every new pattern against sentences that *contain* the trigger but aren't
the field — that is where it fails, not on the happy path.

Repeat-back (earbuds) confirmations are deliberately in the deterministic set:
second-person confirmations count like first-person introductions, but a bare
echo only counts with an explicit confirmation tail, and is rejected whole if
*any* word touches detail vocabulary — echoes repeat every detail, so the
first-word guard that protects introductions is not enough. A repeated-back
partial phone number fills verbatim, never padded into a full one.

Capture copy must stay honest about data flow: the transcript text is sent to
the company's own server for extraction (never claim the words stay on the
device), and the after-call write-up only fills the form when a Quo call is
actually linked to the screen making the promise.
