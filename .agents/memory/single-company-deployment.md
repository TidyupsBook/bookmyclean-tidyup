---
name: One build, several storefronts
description: How a deployment is closed to new companies (a company's own live site) versus left open for new owners to sign up.
---

# A deployment can belong to one company

The app is multi-tenant, but not every address it is served at should hand out
new companies. The owner's own live site is a single company's storefront;
other domains are where new owners sign up. The difference is one runtime
setting (`NEW_COMPANY_SIGNUPS=closed`), never a code branch or a fork.

**Why:** closing the door is a property of the address, not of the software.
A second deployment must not need a second version of the app, and the
multi-company code stays exercised by tests either way.

**How to apply:**
- The refusal belongs *after* the idempotent "you already own a company"
  return in company creation. Closing the door must never lock out the company
  already living behind it — that is the failure that takes the live site down.
- Staff signup is a separate door and stays open: crew create a login and join
  with the company code. Only *creating a company* is closed.
- The client can't infer it. Ship the flag on the signed-in profile payload so
  onboarding shows the join-code door alone, and treat "still loading" as
  closed — flashing a create-a-company wizard and snatching it back is worse
  than a beat of waiting.
- A Replit project has exactly **one** deployment, so "a second address with
  signups open" is a second domain on the *same* deployment, named in
  `SIGNUP_HOST`. That host must both (a) be exempt from the canonical-host
  301 (or the address is unreachable) and (b) open the company-creation door
  per request host — the deployment-wide flag stays `closed`. Read the host
  one way everywhere (X-Forwarded-Host first) or a request can dodge the
  redirect on one reading and be refused signup on the other. An empty/unknown
  host is closed. The signup host's origin also needs a CORS allowlist entry.
