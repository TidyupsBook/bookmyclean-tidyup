---
name: Public base URL must be pinned, not inferred
description: Why URLs a third party approves in advance need PUBLIC_APP_URL rather than a host inferred from REPLIT_DOMAINS
---

A base URL inferred from the running process (`REPLIT_DOMAINS` / `REPLIT_DEV_DOMAIN`)
is fine for endpoints the app registers itself, and wrong for any URL an outside
service must be told in advance and match later.

**Why:** an OAuth redirect URI is approved once, by hand, in the other service's
settings, and must then match character for character on every authorization.
An inferred host differs between the workspace preview and the published site,
and a custom domain is not guaranteed to be first in `REPLIT_DOMAINS`. So the
URL an owner sees is whichever environment they happened to open — approving it
there makes it fail everywhere else, and the failure lands at the final redirect
with nothing on screen explaining why.

**How to apply:** `PUBLIC_APP_URL` overrides the inferred host when set, and is
set in the *production* environment only. Setting it `shared` would point Quo
webhook registration at production from the workspace, so development would
silently stop receiving webhooks. It is a shared helper — pinning it also
canonicalizes public quote links and owner-notify setup links, which is intended.

Any such URL should also be shown in the UI, copyable, rather than described.
An owner asked to supply a callback address will otherwise register the domain
they are looking at. Flag it explicitly when the value on screen is a `.replit.dev`
preview host.
