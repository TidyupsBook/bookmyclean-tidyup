# Book My Cleaning (by Tidyups)

> **Canonical app repository:** this is the codebase deployed to [bookmycleaning.net](https://bookmycleaning.net).

A multi-company SaaS AI phone receptionist for residential cleaning companies.

Companies sign up, connect their own Quo (formerly OpenPhone) workspace and choose which
lines the AI answers, optionally connect Jobber, customize the receptionist, invite their
team, and get a dispatcher dashboard where calls turn into transcripts, quotes and
bookings. Jobber is a convenience, not a requirement — companies without it quote,
schedule and book entirely inside the app.

Live at **https://bookmycleaning.net**.

## Repository identity

This is the canonical Book My Cleaning project for **bookmycleaning.net**.

- GitHub: `tidyups-booking/BookMy_Cleaning_Day1`
- Branch: `book-my-cleaning`
- Publish workflow: push changes here, then publish the pushed version from Replit

If the repository or branch above does not match the VS Code checkout, stop and
switch to the correct project before making changes.

## How it works

1. A customer calls the company's Quo line; the AI receptionist answers and captures the job.
2. The call, its transcript and summary flow into the dashboard via Quo webhooks.
3. A dispatcher reviews the draft quote, edits it, and texts it from the company's own line.
4. The customer opens the quote link, approves, and pays a Stripe deposit.
5. The booking optionally syncs to Jobber as a client + work request.

## Repository layout

This is a pnpm monorepo. Each app lives under `artifacts/` and shared code under `lib/`.

| Path                         | What it is                                                   |
| ---------------------------- | ------------------------------------------------------------ |
| `artifacts/api-server`       | Express API — telephony, quoting, booking, Jobber and Stripe |
| `artifacts/book-my-cleaning` | React + Vite dispatcher dashboard and customer quote page    |
| `artifacts/owner-mobile`     | Expo mobile app for owners                                   |
| `lib/db`                     | Drizzle schema and migrations                                |
| `lib/api-zod`                | Generated OpenAPI types and zod schemas                      |
| `lib/pricing`                | Shared quote pricing rules                                   |

## Development

```bash
pnpm install
```

Workflows start each app individually. Repo-wide checks:

```bash
pnpm run typecheck
pnpm exec prettier --check .
```

## Notes for contributors

- **Database changes require a migration file.** The API applies Drizzle migrations at
  startup, so `drizzle-kit push` alone ships nothing to other environments.
- **Every Quo client call takes the calling company's API key as its first argument.**
  There is no shared fallback — one tenant's key must never serve another's request.
- **Transcripts are post-call, not live.** A transcript arrives seconds after hangup.
- Booking times are stored and rendered in the company's timezone, never browser-local.

See `replit.md` for the full architecture and current status.
