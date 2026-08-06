-- Time actually worked on a job, clocked by the crew on site. One row per
-- start/stop stretch, because jobs get interrupted and the owner bills the
-- sum of the stretches worked rather than first-start to last-stop.
CREATE TABLE IF NOT EXISTS "booking_time_entries" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL REFERENCES "companies"("id"),
  "booking_id" integer NOT NULL REFERENCES "bookings"("id") ON DELETE cascade,
  "team_member_id" integer REFERENCES "team_members"("id") ON DELETE set null,
  "started_by_name" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone,
  "edited_at" timestamp with time zone,
  "jobber_note_id" text,
  "jobber_sync_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- At most one running clock per job: a double tap on a phone with poor signal
-- must not open a second stretch that also gets stopped and double-bills.
CREATE UNIQUE INDEX IF NOT EXISTS "booking_time_entries_open_idx"
  ON "booking_time_entries" ("booking_id") WHERE "ended_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "booking_time_entries_booking_idx"
  ON "booking_time_entries" ("booking_id");
