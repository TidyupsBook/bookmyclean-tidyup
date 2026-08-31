-- IF NOT EXISTS on purpose: this column reached the shared dev database
-- under the task branch's original migration number, then the merge
-- renumbered the file — so it must succeed both where the column already
-- exists (dev) and where it doesn't (production).
ALTER TABLE "activity" ADD COLUMN IF NOT EXISTS "call_id" integer;