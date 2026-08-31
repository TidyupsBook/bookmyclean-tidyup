---
name: Staff presence ("live") definition
description: One server-side rule for who counts as live; how chat/schedule/map surfaces consume it
---

# Staff presence — one "live" definition

**Rule:** "Live" = the member's `cleaner_locations.updatedAt` is within `LIVE_WITHIN_MS` (5 min), computed **server-side** in the api-server presence lib. The web map keeps its own `STALE_AFTER_MS` for marker brightness — the two constants are cross-referenced in comments and must change together.

**Why:** Chat, schedule, and map must never disagree about who is out working; a client-side recomputation from raw timestamps would drift (clock skew, differing windows).

**How to apply:**
- New surfaces needing presence: either embed flags in a response the page already polls (what staff-chat does — `members[].isLive`, `ChatContact.isLive`), or poll the lightweight staff presence endpoint (`liveMemberIds`) like the schedule pages (60s). Don't invent a third pattern or ship timestamps for clients to judge.
- The schema for the presence endpoint is deliberately NOT named `<OperationId>Response` (orval collision) — keep that convention for new presence-like endpoints.
- Owner accounts have no writable location seat, so owners are never live — accepted product behavior, don't "fix" it silently.
- Adding required fields to existing chat schemas was safe because server + clients regenerate together; embedded-flag additions must update every response site of that schema in the same change (four sites for conversations) or zod 500s the route.
