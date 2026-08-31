-- Automatic retries need a durable attempt count so a transient outage does
-- not become an outbound storm, and a permanent refusal does not retry forever.
--
-- Guarded because task merges renumber migration files and Publish may
-- pre-apply DDL before the API's startup migrator runs.
ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "jobber_sync_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bookings_jobber_retry_idx"
  ON "bookings" ("company_id", "jobber_sync_error_at")
  WHERE "jobber_sync_error" IS NOT NULL;