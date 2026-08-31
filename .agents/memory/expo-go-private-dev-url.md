---
name: Expo Go breaks when the dev URL is private
description: Why the phone app loads but can't reach the API — the private dev URL toggle blocks API calls while the Expo bundle still downloads.
---

When the workspace has **Developer tools → Networking → "Private development URL"** switched on,
the mobile app running in Expo Go will load and sign in but fail every API call, with zero
requests ever reaching the API server.

**Why:** the phone fetches the JS bundle from the Expo subdomain (`*.expo.<host>.replit.dev`),
which bypasses Replit's shared proxy, but the app's API base URL is the *main* dev domain
(`EXPO_PUBLIC_DOMAIN=$REPLIT_DEV_DOMAIN`). The main domain sits behind the proxy, so an
unauthenticated request from a phone is answered by Replit's "Log in to access a private app"
HTML page. The request never reaches the app, so the API workflow log shows nothing at all.

The symptom is easy to misread as a network/auth bug in the app, because the in-app copy blames
the connection.

**How to apply:** if the mobile app reports it can't reach the server and the API workflow log
shows *no* incoming requests (not even a 401), do not debug the app. Confirm the wall first from
outside the container — an external screenshot/fetch of `https://$REPLIT_DEV_DOMAIN/api/healthz`
returns the Replit login page, while curl from inside the container returns real JSON. Inside the
container always works, so it proves nothing on its own. Only the user can flip the toggle.

Also note: the API request logger strips query strings, so a `?probe=` marker will not show up in
the workflow log — match on path and timestamp instead.
