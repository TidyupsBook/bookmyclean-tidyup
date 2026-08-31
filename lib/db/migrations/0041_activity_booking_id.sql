-- IF NOT EXISTS on purpose: task merges renumber migration files and Publish
-- may pre-apply columns, so this must succeed both where the column already
-- exists and where it doesn't (same story as activity.call_id).
ALTER TABLE "activity" ADD COLUMN IF NOT EXISTS "booking_id" integer;