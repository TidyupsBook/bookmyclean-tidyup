ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "jobber_connection_id" integer;

-- Imports before multi-account support came from the company's only Jobber
-- account. Tag those rows with the seeded primary connection so later pulls
-- reconcile each account's calendar independently.
UPDATE "bookings" AS b
SET "jobber_connection_id" = c."id"
FROM "jobber_connections" AS c
WHERE c."company_id" = b."company_id"
  AND c."is_primary" = true
  AND (
    b."jobber_visit_id" IS NOT NULL
    OR b."jobber_synced_job_id" IS NOT NULL
  )
  AND b."jobber_connection_id" IS NULL;

DROP INDEX IF EXISTS "bookings_company_jobber_visit_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "bookings_company_connection_jobber_visit_idx"
  ON "bookings" ("company_id", "jobber_connection_id", "jobber_visit_id")
  WHERE "jobber_visit_id" IS NOT NULL
    AND "jobber_connection_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "bookings_company_legacy_jobber_visit_idx"
  ON "bookings" ("company_id", "jobber_visit_id")
  WHERE "jobber_visit_id" IS NOT NULL
    AND "jobber_connection_id" IS NULL;