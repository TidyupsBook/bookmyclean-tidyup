-- Stretches clocked in Jobber's own timer, pulled in here so the office bills
-- one set of hours. Kept in a separate column from `jobber_note_id`: one is a
-- stretch we sent Jobber, the other a stretch Jobber sent us, and confusing
-- the two would post imported hours straight back and count them twice.
ALTER TABLE "booking_time_entries"
  ADD COLUMN IF NOT EXISTS "jobber_time_entry_id" text;
--> statement-breakpoint
-- However often the pull runs, one Jobber timer lands here once.
CREATE UNIQUE INDEX IF NOT EXISTS "booking_time_entries_jobber_entry_idx"
  ON "booking_time_entries" ("company_id", "jobber_time_entry_id")
  WHERE "jobber_time_entry_id" IS NOT NULL;
