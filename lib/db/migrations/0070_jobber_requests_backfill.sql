-- Resumable request backfill, so a company whose post-floor request history
-- is larger than one run's page cap makes progress across runs instead of
-- re-reading the same first pages forever (the sort is REQUESTED_AT, the
-- filter updatedAt — nothing row-derived can resume it, only Jobber's own
-- pagination cursor). Mirrors the quote backfill's cursor+floor pair:
--   started_at  — when the multi-run backfill began; the completing run sets
--                 the watermark this far back so mid-backfill updates are
--                 re-read by the first incremental pull.
--   end_cursor  — Jobber pagination cursor saved by the last capped run.
--   filter_floor — the exact updatedAt filter the cursor was issued under;
--                 Jobber cursors are query-scoped, the pair travels together.
-- Idempotent — task merges renumber files and Publish can pre-apply columns,
-- so this must survive a re-run.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "jobber_requests_backfill_started_at" timestamp with time zone;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "jobber_requests_backfill_end_cursor" text;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "jobber_requests_backfill_filter_floor" text;
