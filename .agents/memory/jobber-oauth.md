---
name: Jobber OAuth PKCE flow
description: OAuth wiring, refresh-token rotation hazard, and why dev/prod can't share one Jobber connection.
---

Real OAuth with PKCE; connect returns authorizeUrl, callback at /api/company/jobber/callback stores encrypted tokens; access token refreshed on demand before every API call.

**Refresh token rotation:** Jobber rotates the refresh token on every refresh (rotation is ON by default and required for marketplace apps). Our refresh path already saves the new refresh token before using the new access token — keep that ordering.

**Why dev's Jobber connection keeps dying:** dev and prod databases carry copies of the *same* company row with the same refresh token. Whichever environment refreshes first invalidates the other's token, so the copy is flagged `jobberNeedsReauth` through no bug of its own. The race can flag *both* sides within minutes — a dev workspace merely running its pollers can take down prod's connection, after which the owner must reconnect on prod. Never treat a "reconnect Jobber" flag as evidence of broken code; each environment needs its own Jobber connection.

**How to apply:** to exercise Jobber APIs from dev, reconnect Jobber in dev (or introspect with docs/examples instead). Also: `invoiceCreate(input: InvoiceCreateAttributes)` exists (clientId, subject, lineItems name/quantity/unitPrice) — invoices land unsent; Jobber applies its own tax settings, so never send tax as a line item.
