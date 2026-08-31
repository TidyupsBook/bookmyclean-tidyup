-- A Jobber webhook delivery claim now records when processing finished.
-- An unfinished claim past a stale cutoff can be taken over by a later
-- retry, so a failed claim release can never lock a delivery out forever.
-- Idempotent: task merges renumber migration files and Publish can
-- pre-apply DDL, so this must survive a second run.

ALTER TABLE "jobber_webhook_deliveries" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;
