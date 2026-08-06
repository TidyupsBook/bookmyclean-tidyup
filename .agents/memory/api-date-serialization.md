---
name: Date columns must be serialized explicitly in API responses
description: Why adding a nullable timestamp column can 500 an entire list endpoint, and what to check when it happens.
---

Response schemas are generated from the OpenAPI spec and validated with zod on the way out.
Drizzle hands back `Date` objects; the spec says `string`. Route serializers convert each date
field by hand, so **adding a timestamp column means updating the serializer in the same change**.

**Why:** a nullable timestamp is invisible until the first row actually sets it. Adding
`quote_sent_at` looked fine — every list request passed — right up until one quote was sent.
From then on the whole collection endpoint threw on response validation and returned 500, so
the UI showed an empty state. The symptom (a list that mysteriously empties) points nowhere
near the cause (a new column on one row).

**How to apply:** when adding a `timestamp` column that any endpoint returns, grep the route
file for the existing `.toISOString()` calls and add the new field beside them, null-safe
(`x ? x.toISOString() : null`). Then exercise the endpoint *after* writing a row that
populates the column — an empty table will not reproduce it.
