-- Automatic Jobber lead retries need a durable attempt count so the poller can
-- back off and eventually stop retrying a permanently refused lead. Manual
-- retries remain available through the existing inbox action.
--
-- Guarded on purpose: task merges renumber migration files and Publish may
-- pre-apply DDL, so this must succeed on a database that already has it.
ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "jobber_push_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_jobber_retry_idx"
  ON "leads" ("company_id", "jobber_push_error_at")
  WHERE "source" = 'form'
    AND "jobber_synced" = false
    AND "status" = 'new'
    AND "jobber_push_error" IS NOT NULL;