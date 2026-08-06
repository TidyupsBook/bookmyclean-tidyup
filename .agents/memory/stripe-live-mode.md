---
name: Stripe live-mode switch
description: How live vs test mode works with the Replit Stripe connector and stripe-replit-sync managed webhooks
---

- Live keys are entered by the user in the Publish pane; the connection API then serves live keys to the deployment and test keys to the dev workspace. No code changes needed — the client fetches credentials fresh per call.
- `findOrCreateManagedWebhook` deletes any stripe-sync-managed webhook in the Stripe account that isn't in the *local* `stripe._managed_webhooks` table ("orphan cleanup"). While dev and prod both run test keys, each boot deletes the other environment's webhook (harmless flapping). Once prod is on live keys, mode-scoped API keys prevent cross-environment deletion entirely.
- On prod's first live-key boot, the stale test-mode webhook row 404s under the live key and is removed/recreated cleanly.
- **Why:** avoids re-investigating whether startup webhook reconciliation can clobber the live webhook — it can't across modes.
- **How to apply:** when going live or debugging missing webhooks, check key mode and deployment visibility (a private deployment rejects Stripe webhook POSTs and customer quote links) before touching code.
