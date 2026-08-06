-- Persist Jobber sync failures on bookings so they aren't silently lost.
-- Idempotent: safe on fresh databases and databases that already applied 0001.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "jobber_sync_error" text;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "jobber_sync_error_at" timestamp with time zone;
