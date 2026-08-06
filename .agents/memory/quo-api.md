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

## Webhook signing
Deliveries are svix-format: `webhook-id`, `webhook-timestamp`, `webhook-signature`
headers, HMAC-SHA256 over `{id}.{timestamp}.{raw-body}`, base64. The signing key is
returned **only in the creation response** as `whsec_...`; strip the prefix and
base64-decode it to get the HMAC bytes. Reject timestamps older than a few minutes.

**How to apply:** persist the key at creation time — there is no endpoint that
re-reveals it later in a usable form, so losing it means deleting and recreating the
webhook.
