---
name: Lead prefill cache freshness
description: Contact repairs on lead cards must update the booking form's separate prefill cache before navigation.
---

The booking form uses a dedicated lead-prefill query, so a lead-card mutation cannot rely on invalidating only the leads list. Successful repairs must update the prefill cache immediately as well as refreshing the list.

**Why:** Owners can start a quote immediately after repairing a missing contact, before a list refetch finishes; otherwise the quote form can restore the old missing-contact state.

**How to apply:** When a lead mutation changes fields used by booking prefill, patch the matching prefill query with the server response before navigating or allowing the next action.