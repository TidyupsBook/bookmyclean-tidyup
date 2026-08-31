-- One bookings row per Jobber visit, enforced by the database rather than by
-- the sync's read-then-write (two sync processes overlap during a rolling
-- deploy). Partial: the job-keyed era left many rows with a null visit id,
-- and those must stay unrestricted.
CREATE UNIQUE INDEX IF NOT EXISTS "bookings_company_jobber_visit_idx" ON "bookings" ("company_id","jobber_visit_id") WHERE "jobber_visit_id" IS NOT NULL;
