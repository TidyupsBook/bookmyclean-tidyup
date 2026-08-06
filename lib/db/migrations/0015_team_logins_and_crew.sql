-- Team members can now hold a real login, and bookings can carry a crew.
--
-- Additive and idempotent: the API runs these at startup, so re-running on an
-- already-migrated database must be a no-op.

ALTER TABLE "team_members" ADD COLUMN IF NOT EXISTS "clerk_user_id" text;
ALTER TABLE "team_members" ADD COLUMN IF NOT EXISTS "clerk_invitation_id" text;
ALTER TABLE "team_members" ADD COLUMN IF NOT EXISTS "claimed_at" timestamp with time zone;

-- One Clerk account may occupy at most one seat. Partial, so the many rows
-- still awaiting sign-up (all NULL) do not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS "team_members_clerk_user_id_unique"
  ON "team_members" ("clerk_user_id")
  WHERE "clerk_user_id" IS NOT NULL;

-- Lookup path for resolving the caller's seat on every authenticated request.
CREATE INDEX IF NOT EXISTS "team_members_company_id_idx"
  ON "team_members" ("company_id");

CREATE TABLE IF NOT EXISTS "booking_assignments" (
  "id" serial PRIMARY KEY NOT NULL,
  "booking_id" integer NOT NULL REFERENCES "bookings"("id") ON DELETE CASCADE,
  "team_member_id" integer NOT NULL REFERENCES "team_members"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "booking_assignments_booking_member_idx"
  ON "booking_assignments" ("booking_id", "team_member_id");

CREATE INDEX IF NOT EXISTS "booking_assignments_team_member_idx"
  ON "booking_assignments" ("team_member_id");
