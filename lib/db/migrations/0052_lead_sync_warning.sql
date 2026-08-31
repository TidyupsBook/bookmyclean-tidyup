-- Non-fatal sync warning: the leads sheet grew a header this code doesn't
-- map to any stored field. The sheet's headers are hand-managed and have
-- renamed before ("how_many_bedrooms?" became "how_many_bedrooms_do_you_have.?"),
-- and when that happens leads still import via fingerprint but fields like
-- service/bedrooms silently go blank. This column lets the Leads page say so.
--
-- Guarded on purpose: task merges renumber migration files and Publish may
-- pre-apply DDL, so this ALTER must succeed on a database that already has
-- the column.
ALTER TABLE "lead_sync_state" ADD COLUMN IF NOT EXISTS "last_warning" text;
