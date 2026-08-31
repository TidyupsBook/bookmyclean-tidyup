-- Persists the Jobber pagination endCursor from a capped backfill run so the
-- next run can resume mid-page rather than restarting the same createdAt
-- filter from the beginning. Without it a tie group of quotes sharing one
-- createdAt second and larger than MAX_PAGES×PAGE_SIZE would loop forever.
-- Cleared when the backfill completes.
--
-- Guarded on purpose: task merges renumber migration files and Publish may
-- pre-apply DDL, so all of this must succeed on a database that already has it.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "jobber_quotes_backfill_end_cursor" text;
