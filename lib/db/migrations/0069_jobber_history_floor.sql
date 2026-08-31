-- One-time Jobber history catch-up, walking forward from the pinned floor
-- (Aug 1, 2026) to the rolling calendar window's back edge for companies that
-- connect after the window has moved past the floor. `synced_to` is the
-- YYYY-MM-DD day the catch-up has imported through (resume cursor);
-- `backfilled_at` marks it finished so it never runs again.
-- Idempotent — task merges renumber files and Publish can pre-apply columns,
-- so this must survive a re-run.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "jobber_history_synced_to" text;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "jobber_history_backfilled_at" timestamp with time zone;
