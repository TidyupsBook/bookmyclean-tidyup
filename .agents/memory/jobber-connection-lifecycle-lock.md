---
name: Jobber connection lifecycle locks
description: The concurrency rule for creating and removing company Jobber connections.
---

Jobber connection creation, primary promotion, and removal must all run under the
same company-scoped PostgreSQL advisory transaction lock.

**Why:** A capacity check must be atomic with its insert, and two simultaneous
removals can otherwise each promote a connection that the other request deletes,
leaving the company mirror pointing at a missing primary.

**How to apply:** Any future endpoint that adds, removes, changes primary status,
or repairs Jobber connection rows should acquire that lock before reading the
connection list and should update the company mirror in the same transaction.