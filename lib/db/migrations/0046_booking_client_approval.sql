-- Approval recorded in the app, and the Jobber job/visit the app itself
-- scheduled from an approved quote. Idempotent: task merges renumber files and
-- Publish may pre-apply columns, so this must re-run clean.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "client_approved_at" timestamp with time zone;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "client_approved_by" text;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "jobber_created_job_id" text;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "jobber_created_visit_id" text;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "jobber_job_web_uri" text;
