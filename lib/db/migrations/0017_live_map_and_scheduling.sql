-- Live dispatch map + scheduling.
--
-- Bookings gain a geocoded position and an expected duration; two new tables
-- hold each cleaner's latest GPS fix and the dispatcher's saved map pins.
--
-- Additive and idempotent: the API runs these at startup, so re-running on an
-- already-migrated database must be a no-op.

ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "lat" double precision;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "lng" double precision;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "geocoded_at" timestamp with time zone;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "duration_minutes" integer;

-- Latest known position per cleaner. One row per team member, upserted as the
-- phone moves rather than a trail of points.
CREATE TABLE IF NOT EXISTS "cleaner_locations" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "team_member_id" integer NOT NULL UNIQUE REFERENCES "team_members"("id") ON DELETE CASCADE,
  "lat" double precision NOT NULL,
  "lng" double precision NOT NULL,
  "accuracy" real,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "cleaner_locations_company_id_idx"
  ON "cleaner_locations" ("company_id");

-- Dispatcher-saved map pins, scoped to the company.
CREATE TABLE IF NOT EXISTS "homeowner_pins" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "address" text,
  "lat" double precision NOT NULL,
  "lng" double precision NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "homeowner_pins_company_id_idx"
  ON "homeowner_pins" ("company_id");
