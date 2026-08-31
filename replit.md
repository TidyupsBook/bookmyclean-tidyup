# Book My Cleaning (by Tidyups)

> **Working here? Read "How every task ends" below before you start.** It is the
> owner's standing rule and it applies to every person and every agent on this
> project, on every rebuild, forever.

## How every task ends (non-negotiable)

**Scope of this rule: the whole project, first task to last.** It is in force
from the moment you read it and it never expires. It binds every agent and
every person who works here — the main agent, isolated task agents, subagents,
human contributors — on every task, however small, and it survives every
rebuild of the workspace. A fresh environment does not reset it.

Every task — no exceptions, no "I'll batch it later", no "I'll push once
there's enough to be worth it" — finishes with these three steps, in this
order:

**1. Commit everything.**

```bash
git add -A
git commit -m "Plain-language description of what the owner can now do"
```

**2. Push to GitHub.** Use the `gitPush` callback (git-remote skill); a raw
`git push` from the shell has no credentials and will fail.

```javascript
const r = await gitPush({});
console.log(r.remote, r.branch); // ALWAYS check where it actually landed
```

Never hardcode the repo name or branch — **this project gets rebuilt and both
change.** Read them fresh each time:

```bash
git remote get-url origin     # the GitHub repo this workspace is linked to
git branch --show-current     # the working branch
git rev-list --count @{u}..HEAD   # unpushed commits; must be 0 when you finish
```

As of the last rebuild that is `tidyups-booking/Jobber-LiveMaps-Day1`, branch
`book-my-cleaning`. If those don't match what git reports, git is right and this
line is stale — trust git and fix this line.

If `gitPush` returns `NO_CREDENTIALS` or `UNAUTHENTICATED`, stop retrying and
send the owner to the Git pane to relink GitHub — the GitHub connector does not
grant push access. See `.agents/memory/git-push-replit.md`.

**3. Say whether it needs publishing — every single time.**

Pushing to GitHub does **not** update the live site at bookmycleaning.net. Close
every task with one plain sentence, even when the answer is "nothing to do":

- **"This is already live — nothing to publish."** (docs, notes, config that
  isn't shipped)
- **"This needs publishing to reach bookmycleaning.net."** (anything in
  `artifacts/` or `lib/` that runs in the app)
- **"Push this now, but hold the publish until X is finished."** — say which
  button to press and why; don't offer both and leave the choice hanging.

Then offer the actual buttons: the Git pane button if there's anything to push,
the Publish button if it needs republishing.

**Verify before you claim done:** `git status` clean, `git rev-list --count
@{u}..HEAD` is 0, and you have stated the publish answer out loud.

---

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
- **Jobber-form leads (webhook + sweep).** A request submitted on Jobber's own form lands in the Leads inbox: the signed webhook at `/api/webhooks/jobber` handles `REQUEST_CREATE` (claim-per-delivery in `jobber_webhook_deliveries`, claim released on failure so Jobber retries), reads the request back with one lean query, and stores it as a `source: "jobber"` lead carrying the Jobber request/client/property ids and web URI. A short-window sweep (`sweepJobberRequestLeads`) rides the sync cycle ahead of the request pull as a safety net for missed deliveries. Requests the app itself pushed never boomerang back as leads, a booking made from a Jobber lead is born `jobberSynced` (never pushed back), and the request pull skips requests already in the inbox. **Owner setup:** webhook topics are enabled in Jobber's _developer app settings_ (Developer Center → the app → Webhooks), not per account — the app must be subscribed to the `REQUEST_CREATE` topic at the same webhook URL used for `APP_DISCONNECT`.
- **Approving and scheduling** (`POST /api/bookings/:id/approve`, owner/dispatcher): records the client's yes locally, then — best effort — approves the matching quote in Jobber, and with `schedule: true` converts it into a scheduled job (`jobCreateFromQuote`) at the booking's date and time **in the company timezone** for its expected duration, with matched cleaners attached. Jobber being unreachable never fails the local approval; the failure lands on the booking like any other sync failure. Changing a scheduled booking's time or crew moves/reassigns the Jobber visit.
- Ids the **app** created (`jobber_created_job_id`, `jobber_created_visit_id`, `jobber_job_web_uri`) are kept apart from the ids that mark rows **imported** from Jobber (`jobber_synced_job_id`, `jobber_visit_id`). The calendar pull adopts an app-scheduled row instead of importing it a second time, and the outbound push still refuses to touch anything that came from Jobber.
- **Jobber is optional.** The setup wizard offers Connect _or_ Skip. Skipping sets `companies.jobber_skipped`, a deliberate choice distinct from "hasn't got round to it". Setup treats the step as resolved when a company is connected **or** skipped (`setupStatus.jobberResolved`), so skipping never leaves the wizard stuck. Connecting later clears the flag automatically; the app refuses to mark a connected company as skipped. Jobber sync controls are hidden for companies that aren't connected.

### Quoting and booking

- Quotes live in our own schema (`bookings.quoted_amount`, `quote_notes`, `quote_message`, `quote_sent_at`), never in Jobber, so a company that skipped Jobber can still price work.
- `POST /api/bookings` creates a booking by hand (walk-ins, repeat customers, a missed call); such rows have no `call_id`.
- **"Confirmed" means the client confirmed** — nothing else. A booking is created `pending` (the create route ignores any status the client sends) and becomes `confirmed` only through approval: the customer tapping the texted quote link, or the office recording their yes with the Approve action (`client_approved_at` / `client_approved_by`). `PATCH /api/bookings/:id` accepts `status: "confirmed"` only for a booking that already has an approval on record, which is how a completed job gets re-opened. Rows confirmed before this rule existed are **left as they are** — no mass relabelling, since nobody can now say whether those clients agreed — they simply show no "client approved" line, and if one is moved off confirmed it can't be set back by hand until it's approved.
- `GET /api/bookings/:id/quote-preview` returns a server-generated **draft** SMS plus `canSend` / `blockedReason` / `fromNumber`. The dispatcher edits it freely; `POST /api/bookings/:id/send-quote` sends whatever they actually approved and stores that text, so the record matches what the customer received.
- Quotes text from the company's **own** Quo line, preferring the line the customer originally called (`calls.quo_phone_number_id`), else their first watched line. `from` must be a number the workspace owns, which naturally prevents texting from another tenant's line. `quote_sent_at` is only written after Quo accepts, so the UI never shows "sent" for a text that never left.
- **All booking times are rendered and parsed in the company's timezone** (`companies.timezone`, default `America/Edmonton`), never the browser's — see `.agents/memory/company-timezone-display.md`. There is no settings UI for the timezone yet.

## Addresses and signup mode

- The published deployment is `bookmycleaning.net` (canonical, pinned via
  `PUBLIC_APP_URL`). Production sets `NEW_COMPANY_SIGNUPS=closed`, so nobody
  landing there can create a new company; crew still join with the code.
- A Replit project has exactly **one** deployment, so a "second address where
  new companies sign up" is a second domain pointed at the **same**
  deployment, named in the `SIGNUP_HOST` env var (bare host or full URL,
  comma-separate several). Requests arriving on that host skip the
  canonical-host redirect and are allowed to create a company; every other
  alias still 301s to bookmycleaning.net and stays closed. A host and its
  `www.` sibling are the same door, and the canonical host can never become
  one however `SIGNUP_HOST` is spelled.
- The signup address is **cleaninghub.io** — `SIGNUP_HOST=cleaninghub.io` is
  set in the production environment. It only works once that domain is linked
  in Publishing → Domains (DNS pointed at this deployment) and the app has
  been republished; until then the value sits unused.
- To move the signup door to a different address: link the new domain in
  Publishing → Domains (or use the extra `.replit.app` URL), change
  `SIGNUP_HOST` in the production environment, and republish. Companies
  created there are ordinary tenants — fully isolated rows, own join code, own
  team — pinned by `company.signupClosed.test.ts`.
- Auth on the second origin needs no extra setup: the Clerk publishable key is
  derived from the host the page was served on and the Frontend API is proxied
  at `<host>/api/__clerk`, so cookies are first-party on whichever address the
  visitor used. The signup host is also added to the CORS allowlist in
  `app.ts`.

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

- **Commit, push, and answer the publish question after every task.** See
  "How every task ends" at the top of this file — that is the full procedure and
  it survives rebuilds. A merged task that only exists in the workspace is not
  finished, and work is not reported as done until the owner has been told
  whether it needs publishing.
- **Any page that scrolls needs a way back to the top.** The dashboard shell
  floats a "Back to top" button (`src/components/ScrollToTopButton.tsx`,
  rendered once in `AppLayout`) that appears after about a screenful of
  scrolling. Any new long page — a list, a feed, a settings screen — must stay
  inside that shell so it inherits the button, or provide its own if it scrolls
  in an inner pane.
- Write plainly. The owner runs a cleaning business, not an engineering team —
  lead with what they can now do, not what was changed in the code.
