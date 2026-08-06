---
name: Quo plan tiers and the absence of a provisioning API
description: Which Quo plan is actually required to build on transcripts, what Sona calls cost, and why auto-signing-up customers is impossible via the public API.
---

## Transcripts are a Business-tier feature, not Starter

Quo's Starter plan includes API access and the Sona AI agent, but **AI call
summaries and transcripts start at Business**. Any product built on
`/v1/call-transcripts` or `/v1/call-summaries` requires customers to be on
Business or higher — Starter customers will authenticate fine and then return
404 for every transcript.

**Why:** the pricing page lists Sona and "Quo API" under "All plans include",
which reads as though Starter is enough. The transcript entitlement is only
visible in the Business column's "Everything from Starter, plus" list.

**How to apply:** when scoping anything that reads Sona transcripts, budget for
the Business seat price, not the headline Starter price, and say so before the
customer commits.

## Sona calls burn credits on top of the seat

Every plan includes 1,000 credits and one Sona call costs 100 — ten calls a
month. Beyond that it is metered: overage starts around $1.00/call, or you
pre-buy credit tiers. For a business taking real call volume the credit spend
can exceed the seat price, so per-customer cost modelling must include it.

## There is no account/number/key provisioning API

The public API's only write endpoints are contacts, messages, tasks,
conversation state, and webhooks. There is **no** endpoint to create a
workspace, create a user, purchase a phone number, or mint an API key.
`/v1/phone-numbers` and `/v1/users` are read-only.

**Why:** this kills any "sign the customer up automatically and hand them a
number" onboarding built on Quo. Their partner programs (affiliate, agency,
technology) are referral and revenue-share arrangements, not white-label
reselling with provisioning.

**How to apply:** onboarding must route through the customer creating their own
Quo account and pasting a workspace API key. If a product genuinely needs
programmatic number provisioning, that argues for owning the telephony layer
(e.g. Twilio) rather than reselling Quo.

## Real-data quirk

Transcript `duration` comes back fractional even though call `duration` is a
whole number of seconds — the two fields disagree in type for the same call.
