ALTER TABLE "staff_devices"
  ADD COLUMN IF NOT EXISTS "recovery_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_devices_member_recovery_idx"
  ON "staff_devices" ("team_member_id", "recovery_key")
  WHERE "recovery_key" IS NOT NULL;