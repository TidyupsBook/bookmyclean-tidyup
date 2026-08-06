---
name: DB migrations & activity enum contract
description: How schema changes must ship in this project — tracked idempotent SQL migrations, and the activity type enum lives in the OpenAPI spec.
---

- Schema changes must ship as a hand-written, idempotent SQL migration in `lib/db/migrations` (ADD COLUMN IF NOT EXISTS) plus a journal entry — `drizzle-kit generate` is broken here (missing snapshots) and `db push` alone leaves fresh/prod DBs behind. The API server applies migrations on boot.
- **Why:** completion review rejects schema-only changes without a tracked migration; migration 0001 set the idempotent-SQL convention.
- Any new activity `type` value must also be added to the `ActivityItem.type` enum in `lib/api-spec/openapi.yaml` (then run codegen) and given an icon case in the dashboard feed — otherwise `/dashboard/activity` fails zod response validation at runtime and the feed breaks. Typecheck cannot catch this because the DB column is plain text.
