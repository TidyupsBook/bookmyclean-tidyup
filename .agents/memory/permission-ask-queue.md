---
name: First-sign-in permission asks queue
description: How multiple one-time browser permission prompts (location, notifications) are serialized on first sign-in
---

The app has multiple one-time "ask once per device" permission prompts mounted in the layout (crew-map location dialog, call-alert notification card). They must never be on screen together — the loser gets dismissed unread, forever.

**Rule:** later asks queue behind earlier ones and are released by an explicit "the dialog actually closed" window event — never by the "asked" storage flag flipping.

**Why:** the storage flag is written the moment a choice is clicked, but the dialog can stay open and busy for a long time afterwards (e.g. "Turn it on" awaits the browser's own geolocation prompt). Any store-driven re-render in that window would surface the queued card over the still-open dialog. Same-tab localStorage writes also fire no event, so a "no" answer would otherwise leave the queued card waiting until the next page load.

**How to apply:** a new one-time ask should (1) hold back while `useThisDevice().ready` is false or any earlier ask is still eligible, (2) treat "saw an earlier ask pending this session" as sticky until that ask's close-announcement event arrives, and (3) itself announce its own closure from every exit path (accept's `finally`, decline, Escape/outside click) for anything queued behind it.

Related: browser notification permission can only be requested from a click, and desktop pop-ups only fire when the tab is hidden — the ask card is the only reason permission ever gets granted, so don't gate it behind pages nobody visits.
