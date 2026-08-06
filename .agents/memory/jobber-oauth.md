---
name: Jobber OAuth PKCE flow
description: How Jobber OAuth 2.0 + PKCE is implemented, including token encryption at rest.
---

## Rule
Jobber uses real OAuth 2.0 + PKCE. Tokens are AES-256-GCM encrypted at rest using `encryptJobberToken`/`decryptJobberToken` from `secretBox.ts` (info label `bookmycleaning:jobber-token:v1`). Never store or return raw Jobber tokens from the DB.

**Why:** Jobber access and refresh tokens are durable OAuth credentials — plaintext storage exposes them in any DB read or backup compromise.

**How to apply:**
- `POST /api/company/jobber/connect` → generates PKCE pair + state, stores in `companies.jobber_oauth` (JSONB), returns `{ authorizeUrl }` — frontend redirects the browser to Jobber.
- Jobber redirects to `GET /api/company/jobber/callback` (unauthenticated) → matches state to company via `jobber_oauth->>'state'`, exchanges code for tokens, calls `encryptJobberToken` before storing.
- `getValidAccessToken(company)` in `artifacts/api-server/src/lib/jobber.ts` → calls `decryptJobberToken` on stored values, auto-refreshes if within 60s of expiry, re-encrypts updated tokens.
- Disconnect: calls Jobber's `appDisconnect` mutation with a decrypted token, then nulls all token columns.
- The OAuth callback URL registered in Jobber Developer Center must be `https://<domain>/api/company/jobber/callback`.
- `JOBBER_CLIENT_ID` and `JOBBER_CLIENT_SECRET` must be set as secrets.

## Verifying Jobber credentials without a browser
Do NOT probe `/api/oauth/authorize` to check whether a client id is real — it 302s to
`api.getjobber.com/login` for a valid key, a wrong key, and pure garbage alike, so it proves nothing.

POST to `/api/oauth/token` instead with the real client id/secret and a junk `code`. Jobber
distinguishes the two failures in plain text:
- `"The provided client id and secret do not match an existing application"` → credentials are wrong.
- `"The provided authorization code was not valid."` → credentials are GOOD; only the code was fake.

**Client id format is not a reliable signal.** Older Jobber apps issue 64-char hex client ids, newer
ones issue UUIDs; the secret stays 64-char hex. A UUID client id paired with a hex secret is normal,
so never reject a pasted credential on shape alone — run the token probe.

## Changing credentials
Swapping the Jobber app invalidates every stored access/refresh token, since they were issued to the
old client id. Check `companies.jobber_access_token IS NOT NULL` before swapping; any connected
company must reconnect. The running API reads these from `process.env` at startup, so a secret change
needs a workflow restart in dev and a re-publish for production.
