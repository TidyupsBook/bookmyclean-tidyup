-- Per-company "required booking fields" setting. Empty means every booking
-- field is optional except the date, and each key in the array turns one
-- form field back into a hard requirement.
-- Idempotent: task merges renumber migration files and Publish can pre-apply
-- columns, so this must survive a second run.

ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "booking_required_fields" text[] DEFAULT '{}'::text[] NOT NULL;
