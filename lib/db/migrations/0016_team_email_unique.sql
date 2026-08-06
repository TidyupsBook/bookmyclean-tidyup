-- One seat per email address per company.
--
-- Without this, two invites racing for the same address create two pending
-- seats and only one of them can ever be claimed, leaving a ghost row the
-- owner cannot explain.
--
-- Additive and idempotent: the API runs these at startup, so re-running on an
-- already-migrated database must be a no-op.

-- Clear any duplicates that predate the constraint, keeping the oldest seat
-- and only ever dropping ones nobody has signed up for.
DELETE FROM "team_members" t
USING "team_members" keep
WHERE t."clerk_user_id" IS NULL
  AND t."company_id" = keep."company_id"
  AND lower(t."email") = lower(keep."email")
  AND t."id" > keep."id";

CREATE UNIQUE INDEX IF NOT EXISTS "team_members_company_email_idx"
  ON "team_members" ("company_id", lower("email"));
