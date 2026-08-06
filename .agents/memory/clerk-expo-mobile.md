---
name: Mobile auth decision
description: How the Expo mobile companion authenticates against the shared API vs web
---

- Mobile (Expo) authenticates with Clerk bearer tokens (no cookie jar); web stays cookie-based — never mix the two.
- Clerk auth screens on mobile must be custom-built; Clerk's prebuilt components don't work in Expo Go.

**Why:** Bearer wiring added to web (or cookie assumptions on mobile) yields silent 401s; verified against the shared api-server.
**How to apply:** Any new Expo artifact talking to the shared API and Clerk tenant.
