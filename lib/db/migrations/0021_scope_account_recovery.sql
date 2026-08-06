-- Put a fence around email-based account recovery.
--
-- 0019/0020 let a company or a seat re-attach to a caller whose verified email
-- matches, once the account holding it is confirmed deleted. That is exactly
-- what the records stranded by the Clerk instance change need — but as a
-- permanent, always-on rule it is too generous. A verified email proves who
-- you are today; it does not prove you are the person who held the record.
-- Addresses get shared within a business, handed to a successor, abandoned and
-- re-registered by a stranger. Left open, "delete the old account, then verify
-- the old address" becomes a route into someone else's company.
--
-- So recovery is scoped to the affected records and expires. Anything created
-- from here on never gets a window, and a genuinely deleted owner is handled
-- by support rather than by whoever holds the mailbox.
ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "owner_recovery_until" timestamp with time zone;
ALTER TABLE "team_members"
  ADD COLUMN IF NOT EXISTS "recovery_until" timestamp with time zone;

-- The stranded cohort: every record that already exists at this point, since
-- the whole database was seeded against a Clerk instance the live site does
-- not authenticate against. Records whose accounts are in fact alive are
-- unaffected — the recovery path still requires a 404 from Clerk.
UPDATE "companies"
SET "owner_recovery_until" = now() + interval '90 days'
WHERE "owner_email" IS NOT NULL
  AND "owner_recovery_until" IS NULL;

UPDATE "team_members"
SET "recovery_until" = now() + interval '90 days'
WHERE "clerk_user_id" IS NOT NULL
  AND "recovery_until" IS NULL;
