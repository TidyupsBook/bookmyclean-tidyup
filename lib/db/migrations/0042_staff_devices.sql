-- Track a DEVICE, not a person.
--
-- Locations used to be one row per team member, so an owner signed in on a PC,
-- an Android, an iPad and an iPhone had four clients overwriting one pin. This
-- gives every device its own identity and moves the current position onto it,
-- then folds each existing location row onto a single "legacy" device for that
-- person so nothing disappears at deploy.
--
-- Everything here is IF NOT EXISTS / guarded: task merges renumber migration
-- files and Publish may pre-apply DDL, so this must succeed on a database that
-- already has all of it.
CREATE TABLE IF NOT EXISTS "staff_devices" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL,
  "team_member_id" integer NOT NULL,
  "device_key" text NOT NULL,
  "label" text NOT NULL,
  "platform" text DEFAULT 'other' NOT NULL,
  "last_seen_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'staff_devices_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "staff_devices"
      ADD CONSTRAINT "staff_devices_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'staff_devices_team_member_id_team_members_id_fk'
  ) THEN
    ALTER TABLE "staff_devices"
      ADD CONSTRAINT "staff_devices_team_member_id_team_members_id_fk"
      FOREIGN KEY ("team_member_id") REFERENCES "team_members"("id") ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_devices_member_key_idx"
  ON "staff_devices" ("team_member_id", "device_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_devices_company_id_idx"
  ON "staff_devices" ("company_id");
--> statement-breakpoint
-- Who may be tracked at all. Off for staff; the owner's own seat is exempt in
-- code, so this column is never consulted for them.
ALTER TABLE "team_members"
  ADD COLUMN IF NOT EXISTS "location_sharing" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "cleaner_locations" ADD COLUMN IF NOT EXISTS "device_id" integer;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cleaner_locations_device_id_staff_devices_id_fk'
  ) THEN
    ALTER TABLE "cleaner_locations"
      ADD CONSTRAINT "cleaner_locations_device_id_staff_devices_id_fk"
      FOREIGN KEY ("device_id") REFERENCES "staff_devices"("id") ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint
-- Backfill: one legacy device per person who already has a stored position,
-- so an existing crew stays exactly as visible after the deploy as before it.
INSERT INTO "staff_devices" ("company_id", "team_member_id", "device_key", "label", "platform", "last_seen_at")
SELECT l."company_id", l."team_member_id", 'legacy-device', 'Phone', 'other', l."updated_at"
FROM "cleaner_locations" l
WHERE l."device_id" IS NULL
ON CONFLICT ("team_member_id", "device_key") DO NOTHING;
--> statement-breakpoint
UPDATE "cleaner_locations" l
SET "device_id" = d."id"
FROM "staff_devices" d
WHERE l."device_id" IS NULL
  AND d."team_member_id" = l."team_member_id"
  AND d."device_key" = 'legacy-device';
--> statement-breakpoint
-- Anyone already transmitting was doing so with the owner's knowledge, so the
-- new switch starts ON for them. A brand new seat still defaults to off.
UPDATE "team_members" m
SET "location_sharing" = true
WHERE m."location_sharing" = false
  AND EXISTS (SELECT 1 FROM "cleaner_locations" l WHERE l."team_member_id" = m."id");
--> statement-breakpoint
-- One current position per DEVICE now, not per person.
ALTER TABLE "cleaner_locations"
  DROP CONSTRAINT IF EXISTS "cleaner_locations_team_member_id_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cleaner_locations_device_id_unique"
  ON "cleaner_locations" ("device_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cleaner_locations_team_member_idx"
  ON "cleaner_locations" ("team_member_id");
