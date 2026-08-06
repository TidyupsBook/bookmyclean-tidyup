# Book My Cleaning (by Tidyups)

A multi-company SaaS: an AI phone receptionist for cleaning companies. Companies sign up, optionally connect Jobber, connect their existing Quo (formerly OpenPhone) workspace and choose which lines the AI answers, customize the receptionist (greeting, collected fields, custom Q&A, services/prices), invite their team, and get a dispatcher dashboard where calls become transcripts and bookings. Jobber is a convenience, not a requirement — companies without it quote, schedule and book entirely inside the app.

## Status

Telephony is **real**: the app reads calls, Sona transcripts, and summaries from the customer's own Quo workspace. We never provision phone numbers — there is no Twilio dependency.

Jobber OAuth is **real**: companies go through a proper OAuth 2.0 + PKCE flow. Tokens (access + refresh) are stored encrypted in the DB. Sync creates real Jobber clients and work requests via GraphQL.

### Quo integration

- Each company connects **their own** Quo workspace. Quo has no OAuth flow, so the owner pastes a workspace API key (Quo settings → API) which is stored AES-256-GCM encrypted in `companies.quo_api_key_encrypted`; only the last four characters are ever returned to the browser. The encryption key is derived from `SESSION_SECRET` via HKDF, so rotating that secret forces every company to reconnect.
- Every Quo client function takes the calling company's key as its first argument — there is no shared fallback, so one tenant's key can never serve another's request. The `QUO_API_KEY` secret is only for local scripts and manual probing.
- Quo's Starter plan does **not** include AI call transcripts or summaries; companies need the Business plan for this product to work. Sona calls also consume credits (1 call = 100; 1,000 credits included per plan).
- `POST /api/company/quo/connect` validates the pasted key against Quo before storing it, `GET/POST /api/quo/numbers` lists the workspace's real lines and records which ones the receptionist watches. A line already claimed by another company is rejected with 409. Disconnect wipes the stored key and deletes the registered webhooks.
- Selecting lines registers three webhooks with Quo (calls, transcripts, summaries) pointing at `/api/webhooks/quo`. Their `whsec_...` signing keys are stored in `quo_webhooks`, because Quo only returns each key at creation time.
- The webhook receiver verifies the svix-style HMAC signature against the **raw** request body. Its raw parser is mounted on the exact webhook path only — see `.agents/memory/express-raw-body-scope.md` for why a broader mount breaks every other route.
- Deliveries are idempotent: each `webhook-id` is claimed in `quo_webhook_deliveries` before processing, so replays and retries of an already-handled event are acknowledged without side effects. Processing happens **before** the response — success returns 200, failure releases the claim and returns 500 so Quo retries. Events for a line the matched company does not watch are ignored.
- Transcripts are **post-call**, not live. `call.ringing` shows a call in progress; the transcript arrives seconds after hangup via `call.transcript.completed`.
- `POST /api/calls/sync` backfills history, since webhooks only cover calls made after setup.

### Jobber integration

- Real OAuth 2.0 + PKCE flow: `POST /api/company/jobber/connect` generates a PKCE challenge and returns `{ authorizeUrl }` — the frontend redirects the user to Jobber to authorize. Jobber redirects back to `/api/company/jobber/callback` with the auth code; the server exchanges it for tokens and stores them (`jobberAccessToken`, `jobberRefreshToken`, `jobberTokenExpiresAt`).
- `JOBBER_CLIENT_ID` and `JOBBER_CLIENT_SECRET` must be set. The OAuth callback URL registered in the Jobber Developer Center must be `https://<domain>/api/company/jobber/callback`.
- Sync (`POST /api/bookings/:id/sync-jobber`) calls `getValidAccessToken` which automatically refreshes when within 60 s of expiry. It then creates a Jobber `clientCreate` + `requestCreate` via GraphQL, attaches extracted wizard answers as a note, and stores the request ID + web URI.
- Disconnect calls Jobber's `appDisconnect` mutation and clears all stored tokens.
- **Jobber is optional.** The setup wizard offers Connect _or_ Skip. Skipping sets `companies.jobber_skipped`, a deliberate choice distinct from "hasn't got round to it". Setup treats the step as resolved when a company is connected **or** skipped (`setupStatus.jobberResolved`), so skipping never leaves the wizard stuck. Connecting later clears the flag automatically; the app refuses to mark a connected company as skipped. Jobber sync controls are hidden for companies that aren't connected.

### Quoting and booking

- Quotes live in our own schema (`bookings.quoted_amount`, `quote_notes`, `quote_message`, `quote_sent_at`), never in Jobber, so a company that skipped Jobber can still price work.
- `POST /api/bookings` creates a booking by hand (walk-ins, repeat customers, a missed call); such rows have no `call_id`.
- `GET /api/bookings/:id/quote-preview` returns a server-generated **draft** SMS plus `canSend` / `blockedReason` / `fromNumber`. The dispatcher edits it freely; `POST /api/bookings/:id/send-quote` sends whatever they actually approved and stores that text, so the record matches what the customer received.
- Quotes text from the company's **own** Quo line, preferring the line the customer originally called (`calls.quo_phone_number_id`), else their first watched line. `from` must be a number the workspace owns, which naturally prevents texting from another tenant's line. `quote_sent_at` is only written after Quo accepts, so the UI never shows "sent" for a text that never left.
- **All booking times are rendered and parsed in the company's timezone** (`companies.timezone`, default `America/Edmonton`), never the browser's — see `.agents/memory/company-timezone-display.md`. There is no settings UI for the timezone yet.

## Architecture

pnpm monorepo:

- `artifacts/book-my-cleaning` — React/Vite frontend at `/` (landing, Clerk sign-in/up, onboarding, `/setup` wizard, dashboard, calls, bookings, team, settings)
- `artifacts/api-server` — Express 5 API at `/api`; Clerk auth (proxy middleware + `requireAuth` via `getAuth`); all data scoped to the company owned by the Clerk userId
- `lib/api-spec/openapi.yaml` — API contract; codegen produces `lib/api-zod` (server validation) and `lib/api-client-react` (React Query hooks)
- `lib/db` — Drizzle/Postgres: companies, services, team_members, calls (jsonb transcript/answers), bookings, activity

## Auth

Replit-managed Clerk. Clerk Organizations are NOT available — companies/roles live in our own DB keyed by Clerk userId. Web auth is cookie-based (no bearer tokens in browser code).

## Conventions

- Change the API by editing `openapi.yaml`, then `pnpm --filter @workspace/api-spec run codegen` (the script rewrites the zod import to `zod/v4` — orval emits zod v4 API).
- Schema changes need **two** things: `pnpm --filter @workspace/db run push` to update the dev database, **and** an additive migration in `lib/db/migrations` with a matching `meta/_journal.json` entry. The API runs Drizzle migrations at startup, so a column that only exists via `push` is missing everywhere but dev. Write migrations as `ADD COLUMN IF NOT EXISTS` so they stay idempotent (only the initial `CREATE TABLE` migration is ever baselined), and verify by dropping the columns in dev and restarting the API.

## User preferences

- **Commit and push after every completed piece of work.** Don't leave finished
  work sitting uncommitted in the workspace. Push to GitHub
  (`tidyups-booking/book-my-cleaning-official`) as part of wrapping up, not as a
  separate thing the owner has to ask for.
- **Say whether a republish is needed.** Pushing to GitHub does not update the
  live site at bookmycleaning.net. Whenever work is finished, state plainly
  whether the change is already live, or whether it needs publishing to take
  effect.
- Write plainly. The owner runs a cleaning business, not an engineering team —
  lead with what they can now do, not what was changed in the code.
