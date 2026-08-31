-- The quote backfill now tracks when it started so that the first watermark
-- run after a multi-run backfill can cover the entire backfill window, not
-- just the last hour.  Stored separately from the watermark so it survives
-- capped (incomplete) runs.
--
-- Guarded on purpose: task merges renumber migration files and Publish may
-- pre-apply DDL, so all of this must succeed on a database that already has it.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "jobber_quotes_backfill_started_at" timestamp with time zone;
