---
name: Live location is per device, and gated by the clock
description: The tracked thing is a device, not a person; sharing is opt-in; and dispatchers may only watch inside company working hours — which makes route tests time-dependent.
---

# A device is what gets tracked

One stored position per **device**, not per roster seat. One person signed in
on a PC, a tablet and two phones is that many pins.

**Why:** the owner signs in from four devices and they all overwrote a single
row, so his pin teleported between them.

**How to apply:** anything *per person* — presence dots, "live now", roster
chips, nearest-crew ranking, next-job trails — must collapse to that person's
freshest device fix. Only map pins fan out. A new query over the location
table that forgets to collapse will double-count anyone with two devices.

# Sharing is opt-in, and "off" means deleted

Effective sharing is `role === 'owner' || locationSharing`. Staff default to
off; the owner cannot be switched off.

**Why:** the owner wanted nothing stored for a cleaner he hasn't turned on —
not merely hidden from the map.

**How to apply:** turning someone off deletes their stored positions. Every
read path filters on effective sharing anyway, so a row that outlived its
switch can never resurface. The report endpoint answers with a distinguishable
"tracking is off" status rather than an error, or clients retry forever.

# Watching is gated on the company clock

Owners see positions at any hour; dispatchers only 08:00–20:00 resolved in the
**company** timezone. Withheld payloads come back empty with a renderable
reason, never filtered in the browser.

**Why:** it has to be genuinely withheld to mean anything, and the viewer's
browser clock is the wrong clock when the owner is travelling.

**How to apply:** per-route checks (never `router.use` — routers mount at `/`).
Apply on every endpoint that leaks a position: map data, trails, presence.
No client may gate *reporting* on its own clock — a phone in another timezone
would stop sending while its owner is on shift, and the owner reports at any
hour by design.

# The clock gate makes route tests time-dependent

Any test that fetches positions as a **dispatcher** against a hard-coded
company timezone passes or fails depending on what time of day the suite runs.

**Why:** the window is resolved against the real clock in the company's zone.

**How to apply:** either ask as the owner (unrestricted), or pick the company
timezone at runtime so the local hour is what the test needs. `Etc/GMT±N`
zones never observe DST, so offset arithmetic on them is exact — remember the
POSIX sign inversion (`Etc/GMT+5` is UTC-5).

# A given device name beats the name a device calls itself

Renaming is a deliberate act against a device id (owner renames any device in
their company, anyone else only their own). A position report may create a
device with the name its client offers, but must never overwrite an existing
label.

**Why:** the label used to ride along on every location post, so renaming the
office PC from anywhere else was undone by that PC's next report thirty
seconds later — indistinguishable from a save that silently failed.

**How to apply:** the report upsert keeps `label` and updates only platform /
last-seen. A client that renames itself locally must also call the rename
route once it knows its device id, and adopt the server's label on each
report so two screens can't disagree.
