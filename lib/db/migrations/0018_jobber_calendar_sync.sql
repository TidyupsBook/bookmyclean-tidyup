-- Bookings imported from Jobber's calendar.
--
-- Separate from jobber_job_id, which stores the Jobber *request* id created by
-- our outbound sync. This column stores the Jobber *job* id a booking was
-- imported from, so the calendar pull can update its own rows without ever
-- touching a booking that originated here.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "jobber_synced_job_id" text;

-- One booking per Jobber job per company. The pull upserts on this, and the
-- constraint is what makes two overlapping syncs safe.
CREATE UNIQUE INDEX IF NOT EXISTS "bookings_company_jobber_job_idx"
  ON "bookings" ("company_id", "jobber_synced_job_id")
  WHERE "jobber_synced_job_id" IS NOT NULL;
