---
name: Verifying SPA deep-link flashes e2e
description: How to e2e-test a hash-deep-link highlight that only fires on page mount/list load.
---

The bookings deep link (`#booking-<id>`) flashes a highlight ring for 2.5s when
the page mounts (or the list finishes loading) with the hash present.

**Why this fools testers:** navigating a browser to the URL it is already on
(same path, same hash) is a no-op in an SPA — no reload, no hashchange, no
effect re-run — so the flash never fires and the run reports a false
regression. Sampling classes at DOMContentLoaded is also too early: the flash
starts only after the data query resolves and the cards render.

**How to apply:** in e2e plans for mount-triggered behavior, force a genuine
remount — navigate to a *different* page first, then to the deep link — and
check within the flash window after the cards render, not after DCL. The jsdom
component test remains the authoritative pin for the class logic.
