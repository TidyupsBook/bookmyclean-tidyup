---
name: Booking times are company-local, never browser-local
description: The rule for displaying and parsing appointment times, and why browser-local formatting is a bug here.
---

Anything that shows or accepts an appointment time must be expressed in the **company's**
IANA timezone, not the browser's. That covers card/list rendering, `datetime-local` inputs
(the value typed is company wall-clock and must be converted on the way in and out), and any
customer-facing message text.

**Why:** the server builds quote texts in company time while the frontend was formatting the
same instant with browser-local `date-fns`. A dispatcher in a different timezone from the
business — travelling, or a remote VA — saw one hour on screen and the customer was texted a
different one. Quoting the wrong arrival time is worse than most bugs this app can have,
because the customer acts on it.

**How to apply:** convert via `Intl` (offset derived from `formatToParts`), which needs no
extra dependency; run the wall-clock→instant conversion twice so DST boundaries settle on the
right offset. Show a short zone label (e.g. "MDT") next to times and next to the scheduling
input so the operator knows which clock they are reading. Expose the company timezone through
the API — a purely server-side timezone cannot keep the UI honest.

The two-pass conversion has a side effect worth keeping intentional: for the repeated
fall-back hour (e.g. 1:30 AM occurring twice), it always converges on the earlier,
still-daylight-saving offset rather than the later standard-time one. Web (`time.ts`) and
mobile (`format.ts`) both rely on this same `zonedInputToIso`/`zoneOffsetMs` shape, so treat it
as one shared, load-bearing contract — a fix or tweak on one side that isn't mirrored on the
other means the same reschedule saves a different instant depending on which app the owner
used.
