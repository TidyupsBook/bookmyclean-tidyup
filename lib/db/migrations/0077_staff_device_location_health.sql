ALTER TABLE "staff_devices"
ADD COLUMN IF NOT EXISTS "location_health" text NOT NULL DEFAULT 'unknown';