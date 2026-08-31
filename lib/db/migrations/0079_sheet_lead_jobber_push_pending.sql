-- A new ad-sheet lead must survive a restart between its durable import and
-- the queued Jobber push. Historical sheet leads stay false: this feature
-- sends new imports only, never silently backfills old enquiries.
--
-- Guarded on purpose: task merges renumber migration files and Publish may
-- pre-apply DDL, so all of this must succeed on a database that already has it.
ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "jobber_push_pending" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_sheet_jobber_push_pending_idx"
  ON "leads" ("company_id")
  WHERE "source" = 'sheet' AND "jobber_push_pending" = true;