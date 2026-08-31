---
name: Device reset recovery
description: How device identity recovery must behave when browser or app storage is cleared
---

A storage reset is recoverable only by matching an opaque, coarse recovery identity scoped to the signed-in seat. Recovery updates the existing device row and removes its stored position; a health-only reset with no match must not create a row.

**Why:** The owner needs to recognize the same crew hardware without retaining or exposing stale coordinates, while a first install must not appear as a device needing repair.

**How to apply:** Keep the recovery identity separate from the normal device key and location payload. Treat a freshly keyed first report as a reset candidate when the recovery identity matches, discard that report's coordinates, and let a later normal report restore sharing.