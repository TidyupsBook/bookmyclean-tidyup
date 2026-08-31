---
name: Live map tool modes
description: Why the map's drop/move/measure modes share one state field, and how a transient tool intercepts marker clicks without rebuilding markers.
---

# Live map tool modes

## One tool field, never parallel booleans

The map's mutually exclusive tools (drop a pin, move a pin, measure) live in a
single state object with one `tool` discriminator plus per-tool payload, and every
transition is a pure function in the lib, unit-tested.

**Why:** with a boolean per mode, exclusivity is a rule someone has to remember at
every call site — and each new tool multiplies the pairs that can be armed at once.
With one field it is impossible to express two active tools.

**How to apply:** adding a tool means adding a variant and its transition, not another
`useState`. Derive `dropMode`/`measureMode` from the field for rendering.

## A transient tool must not depend on the marker redraw effect

Anything that needs to intercept marker clicks (measure snapping to a job or cleaner)
routes through a ref updated in a post-commit effect, the same way the drop handler
does. The marker-building effect must not take tool state as a dependency.

**Why:** that effect tears down every marker and reframes the viewport. Re-running it
on each tool toggle or each point placed makes the map jump under the user, closes the
open card, and drops the overlay mid-interaction.

**How to apply:** marker listeners ask the ref first and bail out if it consumed the
click. Scratch overlays (endpoints, dashed line, chips) get their own effect keyed on
their own state, with full teardown — the periodic refresh must not erase them.

# Role-gated links are baked into marker HTML

Info-window cards are HTML strings built inside the marker redraw effect, so
anything they embed — dispatch-only links, role-gated buttons — is frozen at
draw time. The viewer's role arrives with /me, usually AFTER the first draw.

**Why:** the redraw effect's dep list omitted the role flag, so an owner's
first-loaded map showed read-only cards until an unrelated redraw.

**How to apply:** every flag that changes marker/card HTML must be a dep of
the redraw effect (unlike click-intercepting tool state, which stays a ref).

## Cleaner-to-destination selection is comparison-only

Selecting a cleaner and then a job, saved pin, searched address, or newly
dropped pin draws dispatch context only. It must never assign, reschedule, or
create a booking implicitly; booking stays behind the separate Book action.

**Why:** dispatchers need to compare several possible destinations before
committing work. A map click is too easy and too ambiguous to be a write.

**How to apply:** keep the selected cleaner and scratch comparison client-side.
Destination clicks may update distance/measurement UI, while booking mutations
remain explicit controls with their existing assign/rebook links.
