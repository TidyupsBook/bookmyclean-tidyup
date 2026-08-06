-- The address a company's owner signed up with.
--
-- owner_user_id alone makes ownership only as durable as the login behind it.
-- Delete the Clerk account, or move the database between Clerk instances, and
-- that id points at nothing: the company still exists, still holds every
-- booking, but no one can reach it — the owner signs in and is offered a fresh
-- empty workspace instead, every time.
--
-- Storing the email gives ownership a second, human-stable handle. It is never
-- trusted on its own: re-attaching requires a VERIFIED Clerk email that matches
-- this column AND confirmation that the stored owner account is gone.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "owner_email" text;

-- Lookup happens on the sign-in path for accounts that match nothing else, so
-- it must not table-scan as companies grow. Case-insensitive to match how the
-- comparison is written.
CREATE INDEX IF NOT EXISTS "companies_owner_email_idx"
  ON "companies" (lower("owner_email"))
  WHERE "owner_email" IS NOT NULL;
