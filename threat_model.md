# Threat Model

## Project Overview

Book My Cleaning (by Tidyups) is a multi-tenant SaaS platform that provides an AI phone receptionist for cleaning companies. Each company signs up, connects their Quo (VoIP) workspace and optionally Jobber (field service CRM), customises the receptionist, and receives a dispatcher dashboard where inbound calls become transcripts and bookings.

**Tech stack:** Node.js (Express 5), React/Vite frontend, PostgreSQL via Drizzle ORM, Clerk for authentication, Stripe for deposit payments, pnpm monorepo.

**Users:** Company owners (one per Clerk account) and invited team members (stored in DB but not yet tied to Clerk identities).

## Assets

- **Quo API keys** — Per-company workspace API keys stored AES-256-GCM encrypted. Compromise gives access to a company's phone lines: call history, transcripts, ability to send SMS from their number.
- **Jobber OAuth tokens** — Access + refresh tokens encrypted at rest. Compromise allows creating clients and work requests in a company's Jobber account.
- **Customer PII** — Booking records: customer names, phone numbers, addresses, service history, and quoted prices.
- **Stripe API key / payment sessions** — Used to create Checkout sessions for customer deposits. Compromise allows arbitrary payment operations on the platform's Stripe account.
- **Session credentials** — Clerk session cookies providing authenticated access to the company dashboard.
- **Webhook signing keys** — Quo `whsec_*` keys stored in `quo_webhooks`; used to verify inbound events.

## Trust Boundaries

- **Browser → API** — All client requests cross this boundary. Clerk middleware validates session cookies/tokens. The API must authenticate and authorize every request server-side.
- **API → PostgreSQL** — Application has direct DB access via Drizzle. SQL injection would give full DB access; Drizzle uses parameterized queries throughout.
- **API → Quo** — The server calls Quo with per-company encrypted keys. Per-company key isolation prevents cross-tenant leakage.
- **API → Jobber** — OAuth 2.0 + PKCE. Tokens encrypted at rest. `getValidAccessToken` refreshes automatically.
- **API → Stripe** — Platform-level Stripe secret key. Customer-facing actions (checkout sessions) are scoped by token; raw card data never touches this server.
- **Quo → API (webhooks)** — Events authenticated by svix-style HMAC-SHA256 over raw body + timestamp. Timestamp window prevents replay beyond 5 minutes.
- **Jobber → API (webhooks)** — HMAC verification over raw bytes.
- **Stripe → API (webhooks)** — `stripe-signature` header verified by Stripe SDK.
- **Public / Authenticated boundary** — Landing, `/quote/:token` (customer quote page), Jobber OAuth callback, and webhook receivers are public. All company-data endpoints require Clerk auth.
- **Owner / Team boundary** — All authenticated routes resolve company via `getCompanyForUser(ownerUserId)`. Team members do not yet have independent API access.

## Scan Anchors

- **Production entry points:** `artifacts/api-server/src/app.ts` (Express app), `artifacts/api-server/src/routes/` (all route files), webhook paths at `/api/webhooks/quo`, `/api/webhooks/jobber`, `/api/stripe/webhook`.
- **Highest-risk areas:** `routes/company.ts` (Jobber OAuth callback, company settings), `routes/publicQuote.ts` (unauthenticated payment flow), `routes/quoWebhook.ts` (webhook receiver), `lib/secretBox.ts` (encryption), `lib/jobber.ts` (token management).
- **Public surfaces:** `/quote/:token`, `GET /api/company/jobber/callback`, webhook endpoints.
- **Authenticated surfaces:** All `/api/company/*`, `/api/bookings/*`, `/api/calls/*`, `/api/team/*`, `/api/services/*`, `/api/quo/*`.
- **Dev-only:** `artifacts/mockup-sandbox/` — design sandbox, not production reachable.

## Threat Categories

### Spoofing

Clerk handles authentication via session cookies and middleware. `requireAuth` middleware validates the session and extracts `userId` before any company data is accessed. All company lookups are scoped to `ownerUserId = userId` preventing cross-tenant access.

**Risk:** The Jobber OAuth callback at `GET /api/company/jobber/callback` is unauthenticated by design (Jobber redirects the browser there). It trusts `x-forwarded-host` and `x-forwarded-proto` headers to build the redirect URL, making it exploitable as an open redirect if the Express server is directly reachable without a hardened proxy.

**Required guarantee:** The Jobber callback redirect destination must be validated against an allowlist of known application hostnames, or derived solely from server-side configuration (e.g., `PUBLIC_BASE_URL` env var) rather than request headers.

### Tampering

All quote totals and prices are computed server-side from company settings. Client-supplied prices are not accepted. All booking mutations scope updates to `companyId = company.id`. DB writes use Drizzle parameterized queries.

**Required guarantee:** All booking/call/company write paths must continue to include `companyId` in the `WHERE` clause to prevent cross-tenant writes.

### Information Disclosure

**CORS misconfiguration:** `cors({ origin: true, credentials: true })` reflects the request Origin back in `Access-Control-Allow-Origin` and enables credentials. This allows any origin to make authenticated cross-origin requests and read API responses — effectively bypassing the same-origin policy for authenticated company data.

**Required guarantee:** `CORS` must restrict the `origin` to an explicit allowlist of known frontend origins (the Replit dev/prod domains) rather than reflecting all origins.

### Denial of Service

No rate limiting is applied to any endpoint — including the Quo connect flow (which makes an outbound Quo API call per attempt), the public quote/payment endpoint, or authenticated company endpoints. An unauthenticated attacker can generate unbounded external API calls or DB load via the Jobber callback or public quote paths.

**Required guarantee:** Apply rate limiting to at least the Quo connect endpoint and public payment endpoints.

### Elevation of Privilege

Team members in `team_members` are stored but not tied to Clerk identities. All API access is owner-only. If team login is implemented in future, every route must re-evaluate the `getCompanyForUser` scope to handle member roles correctly.

Jobber OAuth token encryption and per-company key isolation prevent one tenant's credentials from serving another's requests. The Quo webhook receiver verifies signatures and checks that the event's phone number ID belongs to the matched company before ingesting data.

**Required guarantee:** If team-member Clerk accounts are introduced, every route must enforce role-based authorization — owner vs. dispatcher vs. read-only.
