---
name: Clerk web auth is cookie-based
description: How browser API calls authenticate against the Express API with Replit-managed Clerk
---
Web frontend API calls authenticate via Clerk's same-origin session cookie (app at `/`, API at `/api`, same host through the proxy). Do NOT add `getToken()`, `setAuthTokenGetter`, or `Authorization: Bearer` to browser code — that is mobile/Expo only.

**Why:** a code-review pass flagged "frontend doesn't attach auth" as a blocker; the clerk-auth skill explicitly documents this as a false positive for web.

**How to apply:** if web requests get 401s, debug cookie/session loading and middleware ordering, not token transport.
