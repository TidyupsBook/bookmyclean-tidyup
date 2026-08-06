-- One-off repair for a company stranded by a Clerk instance change.
--
-- The live database was seeded from the development one, which means every
-- owner_user_id in it names an account from the *development* Clerk instance.
-- The live site authenticates against a *production* instance, where those ids
-- have never existed. The effect: the owner signs in, is not recognised, is
-- told they have no workspace, and is offered a brand-new empty one — every
-- single time, with their real company sitting untouched behind the wall.
--
-- 0019 added owner_email so ownership survives its login, but only companies
-- created after it have one. This fills in the single pre-existing company,
-- keyed on the exact dead owner id so it cannot touch anything else. It grants
-- nothing by itself: re-attaching still requires a VERIFIED matching email and
-- confirmation from Clerk that the stored account is gone.
--
-- Idempotent: once the address is set, or the company has been re-attached to
-- a live account, the WHERE clause stops matching.
UPDATE "companies"
SET "owner_email" = 'support@tidyupscleaning.com'
WHERE "owner_user_id" = 'user_3HW5ccKqERUiiU32Mkpv9KTWjcA'
  AND "owner_email" IS NULL;
