-- Let the owner name the job himself.
--
-- "Owner", "Dispatcher", "Lead Cleaner" and "Cleaner" are our words, not his.
-- This adds a free-text title that replaces the wording on screen while the
-- underlying role — the thing that actually decides what someone may do —
-- stays exactly as it was. Null means "use the standard wording".
--
-- Guarded on purpose: task merges renumber migration files and Publish may
-- pre-apply DDL, so this has to succeed on a database that already has it.
ALTER TABLE "team_members" ADD COLUMN IF NOT EXISTS "title" text;
