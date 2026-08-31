---
name: Import preview parity
description: Client-side previews of a bulk import must replicate the server's full submission semantics, not just its matching rule.
---

Any UI preview of what `/team/import` (or a similar bulk endpoint) will do must mirror the server exactly:
- match by email first; name fallback only against existing members who have NO email, and only when unique among those;
- match against the WHOLE team (pending members included), not the filtered roster the page displays;
- replicate in-submission duplicate skipping (later rows repeating an identity are skipped, not applied).

**Why:** two rejected code reviews came from a preview that copied only the matching rule — same-named-with-email and duplicate-row cases lied to the owner before a roster-changing submit.

**How to apply:** keep the prediction logic in a shared lib (`staffImportPreview.ts`) with unit tests pinning each server behavior, instead of inlining a "close enough" copy in the component.
