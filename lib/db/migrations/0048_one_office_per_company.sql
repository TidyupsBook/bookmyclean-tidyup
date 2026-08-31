-- One office per company as a DATABASE guarantee, not route discipline: two
-- devices both flagged would leave the map picking one arbitrarily. Clean up
-- any duplicates first (keep the newest flag), then lock the invariant in.
UPDATE "staff_devices" SET "is_office" = false
WHERE "is_office"
  AND "id" NOT IN (
    SELECT MAX("id") FROM "staff_devices" WHERE "is_office" GROUP BY "company_id"
  );--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_devices_one_office_idx"
  ON "staff_devices" ("company_id") WHERE "is_office";
