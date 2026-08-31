---
name: Timezone labels need an instant
description: DST-sensitive labels must describe the relevant timestamp, not the current date
---

Timezone abbreviations are instant-dependent. Any label describing a booking, saved value, or historical event must pass that event's instant to the timezone-label helper; omitting it silently labels the timezone as of "now".

**Why:** During the fall-back hour, the same zone has different abbreviations at different instants, so a current-date default can make a correct saved time look wrong.

**How to apply:** When rendering or asserting a booking-related zone label, derive the label from the exact ISO instant being displayed or persisted. Use a no-instant label only for intentionally current-time UI.