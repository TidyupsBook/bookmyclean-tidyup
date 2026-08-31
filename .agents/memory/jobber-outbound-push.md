---
name: Jobber outbound push
description: How bookings/quotes are created in Jobber, why the first version silently never worked, and the schema facts that constrain it.
---

## Verify Jobber's schema before writing a mutation

Jobber's GraphQL endpoint answers **introspection without any Authorization
header** (a bogus token is rejected, no header is not). Post an introspection
query and read the real input fields/enums.

**Why:** the original outbound push had never once succeeded — it sent `source`
as free text (it's an enum) and an inline `property` object (the field is
`propertyId`). Jobber rejected every call, and because pulled-in bookings show
as "synced", the failure was invisible for months.

**How to apply:** any new Jobber mutation gets its input shape confirmed by
introspection first, and a test that asserts the outgoing GraphQL variables.

## Validate every document, not just new mutations

One wrong field name fails the **whole** GraphQL document, so a single stale
selection ("give me the phone's `raw`") kills a push before any mutation runs.
Jobber's schema drifts between versions, and there is no compile-time check.

**Why:** every outbound push for a live account died at the client lookup with
`Field 'raw' doesn't exist on type 'ClientPhoneNumber'` — a field that was only
ever *read*, not written, so mutation-shape checks missed it entirely.

**How to apply:** extract every query/mutation literal and POST each one
unauthenticated; anything other than an auth error is a real schema problem.
Do it for reads and writes together, and re-run it whenever a Jobber call
starts failing for a reason that sounds structural. Notes are per-subject
mutations (`requestCreateNote`, `jobCreateNote`) — there is no generic
`noteCreate`.

## Stub Jobber at the HTTP boundary in tests

Mocking our own `lib/jobber` helpers cannot catch a malformed mutation, and
partially mocking that module doesn't work anyway: functions inside it call
their module-local `jobberGraphql`, not the mocked export. Stub `fetch`.

## Schema facts that shape the design

- A work request needs `clientId` **and** `propertyId`; a quote needs both too,
  plus optional `requestId` to hang it off the request.
- A client's addresses are `clientProperties`, not `properties`; new addresses
  come from `propertyCreate`.
- Jobber address inputs separate `street1` and `street2`; property edits must
  send `street2: null` to clear a prior unit or suite.
- Property reuse must compare normalized `street1` *and* `street2`, or one
  customer's two suites at the same building collapse into one Jobber property.
- Quote line items require `name` and `saveToProductsAndServices` (send
  `false`, or quoting edits the company's saved price list).
- Client search is fuzzy — compare the last ten digits yourself before deciding
  a hit is the same person, or you attach a booking to a stranger.

## Rules for the push itself

- Store the Jobber client id the moment Jobber returns it, before attempting
  the request, or a later failure orphans a client nobody can find and the
  retry mints a duplicate.
- Claim the booking (marker in the id column, stale after minutes, released on
  failure) before any call. If the finalizing conditional update loses, the
  claim was stolen: report skipped and write nothing — never announce a sync
  that another attempt owns.
- Never push back a booking that carries inbound Jobber ids; that clones the
  owner's own job.
- Serialize pushes per company. The rate budget is per Jobber account and
  shared with the calendar pull, so a burst of new bookings throttles the whole
  integration; serializing also stops two bookings for one new customer from
  each creating that customer.
- Residual risk, accepted: if Jobber commits and the response is lost, a manual
  retry can duplicate. There is no idempotency key in the API. Nothing retries
  automatically, so the duplicate needs a human to press the button.
- Never send a field Jobber treats as present-but-empty. A client created with
  `phones: [{ number: "" }]` is rejected outright, so a contactless booking
  fails its whole sync; omit the key instead and a name-only client goes
  through. Same rule for any blank text that titles something on the far side —
  give it a plain fallback label rather than an empty title.
- A missing field in `propertyEdit` retains Jobber's existing value; send an
  explicit `null` only when the local field was deliberately cleared.
