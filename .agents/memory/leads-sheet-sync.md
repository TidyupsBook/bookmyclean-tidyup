---
name: Leads sheet sync
description: How the Google Sheets leads inbox is scoped and why values stay raw
---

The Facebook/Instagram leads Google Sheet is a single global spreadsheet (id in
`LEADS_SPREADSHEET_ID` env or a constant), not per-tenant config.

**Rules:**
- Production pins the shared feed to one explicit company. Never infer the
  destination from the oldest company row: stale seed/test companies can precede
  the real owner and silently steal both imports and sync health.
- Sheet availability, status details, manual sync/preview, and stale catch-up are
  scoped to that configured company. Other companies receive an explicit
  unconfigured state with no tab names, errors, warnings, or timestamps.
- The oldest-company fallback exists only for environments with no explicit
  destination configured, preserving local/test behavior.
- Sheet values are stored **verbatim** ("1 or 2" bedrooms, province "Canada");
  the only derived column is `phone_e164`. The booking-form prefill only moves a
  value into a structured box when it actually fits (clean integer, known
  province code, known service) — everything else goes to notes as raw text.
- The requested-service date is free text and is **never parsed** into a
  scheduled time.
- Idempotency lives in the DB: unique (company_id, sheet_lead_id) +
  ON CONFLICT DO NOTHING, whole runs serialized by a pg advisory xact lock.
  Safe to run in every environment (read-only sheet, per-env DB) — unlike the
  Jobber poller there is no shared rotating credential.
- The sheet connection is read-only; `lead_status` in the sheet is never
  written back. Conversion state lives only in our `status` column, claimed by
  a conditional update (`status != 'converted'`), and converted is final —
  dismiss returns 409 rather than erasing the booking link.

- Leads get map pins via the shared geocode backfill (address-keyed cache).
  Any fire-and-forget side effect triggered from `runLeadsSync` must be gated
  on `NODE_ENV !== "test"`: the test suite calls the sync in-process against
  the shared dev DB with a null-returning stub geocoder, and one run cached
  "unplaceable" for every real lead address for a month.

- **The owner hand-types leads into the sheet** (new tabs like "Anywhere
  Leads") with no export id, phone, or email. Id-less rows qualify for the
  fingerprint key on phone/email OR a name plus another lead detail (address,
  city, service, rooms, requested date) — a lone name stays out (notes,
  staff lists), and a row whose every non-empty cell equals its own column
  name is an echoed header, skipped before the explicit-id branch (it
  carries `id`="id").
- **Tab names are discovered per run, never hardcoded.** They belong to whoever
  keeps the sheet and they change: tabs get renamed mid-month as ad sources are
  split out, and a new one appears each month. A fixed list fails silently —
  the page just stops filling. Distinguish the two failures: `400 Unable to
  parse range` means the tab is gone or renamed; `404 No google-sheet
  connection found` means the connector isn't attached in that environment.
- The sheet is read through the Replit **`google-sheet` connector**, not an API
  key: `connectors.proxy("google-sheet", "/v4/spreadsheets/...")`, with the
  spreadsheet id a constant that env can override. A `404 No google-sheet
  connection found` therefore means the connector is not attached in *that*
  environment — not a wrong id and not an expired token. Each environment needs
  its own connection, and read-only scopes are enough.
- Google Sheets metadata also lists `OBJECT` tabs, which have a title but no
  A1-addressable cell grid. Dynamic discovery must exclude that sheet type
  before values reads; keep `GRID` and `DATA_SOURCE` tabs dynamic.

**Why:** guessing at messy ad answers silently rewrites what the customer
typed, a re-sync or restart must never duplicate or double-convert a lead, and
global sheet diagnostics must not become either a false outage or a tenant data
leak for companies the sheet does not feed. Production once routed the feed to a
stale seeded company because it had the smallest id.

**How to apply:** whenever the production company changes, update the explicit
lead-company setting before publishing. Keep status and import routes scoped to
the same resolver.
