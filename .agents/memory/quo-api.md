---
name: Quo (formerly OpenPhone) API constraints
description: Non-obvious behaviors of the Quo public API that shape how call and Sona transcript ingestion has to be built.
---

# Quo API constraints

## Auth
The `Authorization` header takes the **raw workspace API key with no `Bearer ` prefix**.
Adding the prefix returns 401. The key is workspace-scoped (owner/admin generates it
in workspace settings → API tab); there is no OAuth flow, so a multi-tenant product
needs one pasted key per customer workspace, stored encrypted server-side and never
echoed back. A cheap way to validate a pasted key is `GET /v1/phone-numbers`.

## You cannot list all calls for a number
`GET /v1/calls` requires **both** `phoneNumberId` *and* `participants` (the other
party, E.164, max 1). There is no "all calls on this line" query.

**How to apply:** to enumerate history, walk `GET /v1/conversations?phoneNumbers=<id>`
first, take each conversation's non-workspace participant, then query `/v1/calls` per
participant. Passing `participants[]=` as a bracketed array param fails validation —
use a plain repeated `participants=` key.

## Transcripts are post-call, never live
`call.ringing` is the only mid-call signal. Transcript and summary bodies only exist
once Quo finishes processing, announced by `call.transcript.completed` and
`call.summary.completed`.

**Why:** it is tempting to promise "live transcription" from Sona. The API cannot do
word-by-word streaming; the honest product framing is "call appears live as ringing,
full transcript lands seconds after hangup."

## Transcript speaker attribution
`dialogue[]` entries carry `identifier` (a phone number) and sometimes `userId`.
There is no explicit "this was the AI" flag. Sona speaks from the workspace's own Quo
number, so attribution means testing `identifier` against the set of workspace numbers
from `/v1/phone-numbers` (and treating a present `userId` as the business side too).

## Webhook signing — TWO schemes, and the real one is the legacy one
Webhooks registered through `/v1` sign deliveries with a **single
`openphone-signature` header**: `hmac;1;<timestamp-ms>;<base64>`, HMAC-SHA256 over
`{timestamp}.{raw-body}` with the base64-decoded signing key. The svix-style trio
(`webhook-id`/`webhook-timestamp`/`webhook-signature`, signing
`{id}.{timestamp}.{raw-body}`, key prefixed `whsec_`) is what Quo's newer docs
describe, but real `/v1` deliveries do NOT carry those headers. A handler must accept
both; on the legacy path there is no delivery-id header, so idempotency claims use the
payload's own event `id` (which is also the scheme-stable choice when both exist).

**Why:** the handler shipped trio-only and rejected 100% of real deliveries as
"missing signature headers" — while its self-signed tests passed. Validating a webhook
receiver only against requests you signed yourself is circular; capture a real
delivery's header *names* in logs before trusting the scheme.

The signing key is returned **only in the creation response**; persist it then —
nothing re-reveals it later, so losing it means delete-and-recreate. Timestamp age
gate must tolerate ms units and Quo's long retry tail (hours, original timestamp).
