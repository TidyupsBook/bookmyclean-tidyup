-- Leads can now arrive from more than the Google Sheet: the public request
-- form on the website inserts rows directly (and a Jobber import may later).
-- `source` records where each row came from; every row that exists before
-- this migration was imported from the sheet, which is exactly what the
-- default backfills.
--
-- The idempotency column keeps its historical physical name (sheet_lead_id)
-- even though it now holds any source's external id: Publish diffs the dev
-- schema into production before boot, and a column rename risks being applied
-- as drop+add — losing every lead's identity. The Drizzle property is renamed
-- instead (externalId), so only code says the new name.
--
-- Guarded on purpose: task merges renumber migration files and Publish may
-- pre-apply DDL, so all of this must succeed on a database that already has it.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'sheet' NOT NULL;
--> statement-breakpoint
-- "How did you hear about us?" from the request form. Sheet rows never have
-- it (the ad carries campaign/platform columns instead).
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "heard_about" text;
