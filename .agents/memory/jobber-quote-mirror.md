---
name: Jobber quote mirror & client directory
description: Watermark rules for pulling Jobber quotes, approval provenance, and identity rules for the deduplicated client directory.
---

# Jobber quote mirror

**Rule:** The quote-pull watermark must be a separately persisted per-company cursor (`companies.jobber_quotes_synced_through`) that advances only when a pull read every page Jobber offered — never derived from the mirrored rows.

**Why:** Jobber's `quotes` query has no UPDATED_AT sort key (only CREATED_AT, LAST_SENT_AT, …), so pages arrive in creation order while the filter is `updatedAt: {after}`. A capped/incomplete pull still writes rows, and those rows can carry updatedAt values newer than updates sitting on the unseen pages — a MAX(row.updatedAt) watermark then permanently skips them. Caught by an architect review after shipping the row-derived version.

**How to apply:** Any incremental pull from an API that can't sort by the field it filters on needs completeness-gated cursor advancement (set to sync-start time on a complete pull, minus a small overlap on read). Store the cursor apart from the data. Quote statuses are stored as verbatim text, not an enum — a new Jobber status must never break validation.

# Client directory

- One row per customer per company in `clients`; identity precedence: jobberClientId → phoneE164 → raw phone verbatim. Fill-blanks-never-erase; name always follows the newest sighting.
- A "phone" with no digit in it ("Unknown", "N/A") identifies nobody — treat as absent everywhere (upsert and backfill), or one junk "Unknown" client row per company appears.
- `recordClientContact` never throws by contract; every caller treats directory bookkeeping as best-effort beside the operation that saw the customer.
- Both new tables cascade on company delete — the whole API test suite deletes fixture companies in cleanup, and a derived-bookkeeping FK without cascade broke every suite that creates bookings.

# Capped pulls starve without a resumable backfill

A mirror pull filtered on `updatedAt` with sort CREATED_AT ASC and a page cap
repeats the same first pages forever once history exceeds cap×page-size —
the watermark rightly holds, but nothing ever reaches the later pages.

**Why:** holding the watermark only prevents loss if a later run can make
progress; with an identical filter it cannot.

**How to apply:** the invoice mirror runs a two-mode sync: backfill mode (no
watermark) filters on `createdAt` after MAX(jobber_created_at) in the mirror
(safe because sort matches the filter, so mirrored rows form a complete
prefix), then sets the watermark an hour behind the finishing run to re-read
updates that landed mid-backfill. The QUOTE sync still has the un-resumable
form — fix it the same way if a big account ever stalls at ~1000 quotes.

# The quote pull claims the lead its request answers

When an imported quote's request id matches an unconverted Jobber-origin
lead, the pull converts the lead to the quote's booking with the same
conditional one-shot claim as the manual convert route — but gated on
`status = "new"`, deliberately stricter than the manual route's
`ne(status, "converted")`.

**Why:** a dismissed lead is a decision the owner made in the inbox; a
background sync must never overrule it, while a human clicking "Create
booking" on a dismissed lead is that same owner changing their mind.

**How to apply:** any future automated path that converts leads (webhooks,
other pulls) copies the `status = "new"` guard; only human-initiated
conversions may claim non-new leads. Matching on the real request id
inherently skips `pending:` claim markers. The Jobber-ID transfer step is
skipped on this path — an imported booking is already wearing Jobber's ids.

A fresh outbound quote push hangs the quote off `jobberJobId` (our pushed
request) or, failing that, `jobberSyncedRequestId` (the request the booking
was born from) — either keeps one enquiry as one thread in Jobber instead of
a loose quote beside its request.

# Quote approval provenance

**Rule:** Local office approval, public quote-link approval, and a mirrored
Jobber approved/converted status are distinct sources. Scheduling may rely on
any of them, but it must never stamp a local approval or activity as a side
effect. An existing Jobber job id proves scheduling, not approval.

**Why:** Jobber has no supported quote-approval mutation. Treating conversion
or scheduling as local approval creates a false “recorded by” audit trail and
makes a Jobber outage block an owner from recording what the client said.

**How to apply:** Record local approval without contacting Jobber. Convert an
already-approved quote with Jobber's supported quote-to-job operation only
after an explicit scheduling action, and label the observed approval source
honestly on every surface.
