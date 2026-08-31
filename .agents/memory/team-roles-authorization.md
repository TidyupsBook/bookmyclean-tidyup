---
name: Team roles and the authorization boundary
description: Why resolving a company is not the same as permission in this multi-tenant app, and how owner/dispatcher/cleaner access is enforced.
---

# Resolving a company is scope, not permission

`getCompanyForUser` answers "whose data is this request about". It does NOT
answer "may this caller act on it". Every authenticated route must declare the
roles it accepts with `requireRole(...)`.

**Why:** team members were given real logins by making company resolution fall
back from `companies.owner_user_id` to a `team_members` seat. That one change
made every existing route — company settings, Quo credentials, Jobber OAuth,
go-live, service pricing, call transcripts, quoting, sending money links —
reachable by a cleaner, because those routes used "did I get a company back?"
as their entire authorization check. Hiding navigation in the sidebar is not
authorization; the API is directly callable.

**How to apply:** when adding a route, or when changing how a caller is
resolved, ask which of owner / dispatcher / cleaner may call it and attach
`requireRole`. Default-deny: a route with no guard is reachable by the whole
company including crews, which is only ever right for things everyone may see
(currently just `GET /company` for timezone/branding, and `/me`).

Role intent:
- **owner** — everything, including company config, connections, billing, team.
- **dispatcher** — the day-to-day board (calls, bookings, quotes, crews). No
  company config, no connections, no team changes.
- **cleaner** — only the jobs they are assigned to, and only status changes on
  them. Enforced in SQL on list endpoints, and with an assignment lookup on
  the per-booking update.

# Redact content, not just scope

Scoping a cleaner's list to assigned jobs is not enough: the serialized
booking still carried quote pricing, quote lifecycle/URL, and Jobber state.
Sensitive fields must be nulled at the API boundary
(`redactBookingForCleaner`) — hiding them in the mobile/web UI is not a
boundary because the authenticated response is directly readable.

**Why:** completion review rejected UI-only hiding as a pricing disclosure.
**How to apply:** any endpoint a cleaner can call that returns booking-shaped
data must run the cleaner projection; contract keeps one Booking shape with
those fields nullable.

The same rule applies to **free-text** payloads. Activity feed messages are
prose written for dispatch and quote phone numbers and dollar figures inline,
so opening that feed to crew required masking those patterns on the way out
rather than a field-level projection.

**Why:** the owner's standing preference is that crew see customer names,
addresses and times but never contact numbers or what a job is worth. Refusing
crew the whole feed was the safe first move; the owner asked for a trimmed
version instead.
**How to apply:** when a role gains access to anything containing operator-
written text, check the text itself, not just the column list. Loose phone
regexes must be filtered by digit count or they eat ISO dates and job numbers.

# A seat is not the same thing as a person

The roster holds staff who never sign in, so `team_members.email` is nullable
and only decides whether someone *can* log in. Anything matching a caller to a
seat must treat a missing address as "never matches", never as `""`.

**Why:** most cleaning crews include people who don't use the app, but the
owner still needs their phone number and home address on the schedule and the
map. Requiring an email would have meant a second, parallel notion of "person".
**How to apply:** a seat with no email is `status: "active"` (nothing is
outstanding) with `hasLogin: false` — never "waiting to join", which would be a
lie. Postgres allows many NULLs in the `(company_id, lower(email))` unique
index, so duplicates stay impossible without blocking emailless staff.

**Lead cleaner is a label, not a role.** It lives in its own `is_lead` column
and the dropdown flattens `(role, is_lead)` into three words on screen. Adding
a `lead_cleaner` value to `role` would have put a new row in the authorization
matrix for something the owner described as purely a title.

**`active` is enforced, not decorative.** Off-roster staff are rejected by crew
assignment server-side; hiding them in the picker alone would make the toggle a
suggestion.

# Seat claiming

An invited person is matched to their seat on first sign-in by **verified**
Clerk email only — an unverified address would let someone hijack an invite by
typing it in. The claim is a conditional `UPDATE ... WHERE clerk_user_id IS
NULL`, which is what makes concurrent first requests safe.

The owner approved this identity model for staff: the roster phone number is
contact information, while a verified email is the sign-in identity that
recovers the same staff role/profile on any device.

**Why:** matching an account by a phone number someone typed would let an
attacker take over another worker's profile. Managed Clerk does not offer
phone-number sign-in here, and email verification supplies proof of control.

**How to apply:** keep staff authorization bound to the Clerk user ID after
the first verified-email claim. Do not make a raw roster phone number a login
or account-linking key; preserve it for calls, texts, and display.

A signed-in account with no company and no seat is treated as a *prospective
owner*, not as denied — that is the onboarding state, and it is what lets
someone create their first company.

**Known product limitation:** `clerk_user_id` is unique table-wide, so if two
companies invite the same address, the first claim wins and the other invite
stays pending forever with no signal to that owner.

# Keeping the hot path off Clerk

Authorization resolution must stay a pure database lookup. Clerk is only called
on the rare first-sign-in bootstrap (negative-cached ~60s) and in `/me` for
display name/email. Fetching the owner's Clerk profile on every request added a
network round trip to every single API call.

# Job titles are free text, and still not a role

`team_members.title` is the owner's own wording for a seat ("Site Supervisor")
and, when set, replaces the standard role wording everywhere. Null means the
standard wording.

**Why:** the owner wanted to invent his own role names. Adding them to `role`
would have put arbitrary user-typed values into the authorization matrix.

**How to apply:** the server computes one `roleLabel` (title, then the
role/isLead wording) and ships it on the payload — clients must render that,
never re-derive it, or a card and a map pin drift apart. A title is writable
by whoever may edit the card (never a cleaner editing their own), and nothing
that decides access may read `title`.
