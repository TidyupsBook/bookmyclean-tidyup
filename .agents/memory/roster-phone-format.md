---
name: Roster phone format
description: Team-member phones are stored as typed, not E.164 — any lookup by phone must normalize both sides.
---

Team-member `phone` values are persisted exactly as the owner typed them ("555-123-4567"), while Quo webhooks and outbound paths deal in E.164 ("+15551234567").

**Why:** an equality match on the raw column silently misses most real rosters — a staff SMS reply was routed to the customer inbox because of this.

**How to apply:** never `eq(teamMembersTable.phone, someE164)`. Fetch the (company-sized) roster and compare `toE164(stored) === toE164(incoming)` — see `findActiveMemberByPhone` in the API server's staff chat lib. Owner phone fields (notification/ring-through) ARE normalized at save time; roster phones are not.
