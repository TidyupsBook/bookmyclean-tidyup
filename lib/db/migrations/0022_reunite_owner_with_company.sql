-- Clear the duplicates the onboarding loop created, and point recovery at the
-- address the owner actually signs in with.
--
-- Two things had to be corrected. 0020 guessed the owner's address from the
-- dead development Clerk account; the owner signs in with a different one.
-- And the loop had by then produced two empty companies, one per attempt.
-- Those matter more than they look: resolveCaller checks owned companies
-- before anything else, so an account that owns an empty company never reaches
-- the recovery path at all — it just lands in the empty one, forever. The real
-- company stays unreachable no matter how good the recovery logic is.
--
-- Every statement is guarded so it cannot touch anything but the records
-- described here, and is a no-op in any database where those records are
-- absent — including development, where the owner account is alive and the
-- duplicates never existed.

-- The address the owner signs in with, replacing the guess from 0020. This
-- still grants nothing on its own: re-attaching requires the address to be
-- verified with Clerk AND the stored owner account to come back 404.
UPDATE "companies"
SET "owner_email" = 'cleaningserviceyeg@gmail.com',
    "owner_recovery_until" = now() + interval '90 days'
WHERE "owner_user_id" = 'user_3HW5ccKqERUiiU32Mkpv9KTWjcA';

-- The empty duplicates, children first so no foreign key is left dangling.
--
-- The guard is pinned three ways, because this deletes rows from a live
-- database and each check covers a different way of being wrong. The company
-- ids are the two observed duplicates, so a company created later under the
-- same account can never match. The owner ids confirm those rows are still the
-- ones seen, in case the ids mean something else by the time this runs. And
-- "empty" is required outright: no bookings, no calls, and no team member who
-- has ever signed in — only the placeholder seat every new company is created
-- with. Deleting those placeholders does not weaken the guard for the
-- statements that follow, since it only ever tests for *real* members.
--
-- The guard is repeated verbatim per statement rather than collected into a
-- data-modifying CTE, where the ordering between child and parent deletes
-- would not be guaranteed. Every table carrying a company_id is covered:
-- activity, services, quo_webhook_deliveries, quo_webhooks, homeowner_pins,
-- cleaner_locations, team_members — plus bookings and calls, which the guard
-- has already established are absent. booking_assignments has no company_id
-- and cascades from bookings, of which there are none.
DELETE FROM "activity" WHERE "company_id" IN (
  SELECT c."id" FROM "companies" c
  WHERE c."id" IN (60, 61)
    AND c."owner_user_id" IN ('user_3HW7oKOVVPPUX1aEW7XeCxRWfX4', 'user_3HWRMQy3sMmshdiliMsuCqpaisp')
    AND NOT EXISTS (SELECT 1 FROM "bookings" b WHERE b."company_id" = c."id")
    AND NOT EXISTS (SELECT 1 FROM "calls" k WHERE k."company_id" = c."id")
    AND NOT EXISTS (SELECT 1 FROM "team_members" t WHERE t."company_id" = c."id"
      AND (t."clerk_user_id" IS NOT NULL OR t."email" <> 'owner@company.com'))
);

DELETE FROM "services" WHERE "company_id" IN (
  SELECT c."id" FROM "companies" c
  WHERE c."id" IN (60, 61)
    AND c."owner_user_id" IN ('user_3HW7oKOVVPPUX1aEW7XeCxRWfX4', 'user_3HWRMQy3sMmshdiliMsuCqpaisp')
    AND NOT EXISTS (SELECT 1 FROM "bookings" b WHERE b."company_id" = c."id")
    AND NOT EXISTS (SELECT 1 FROM "calls" k WHERE k."company_id" = c."id")
    AND NOT EXISTS (SELECT 1 FROM "team_members" t WHERE t."company_id" = c."id"
      AND (t."clerk_user_id" IS NOT NULL OR t."email" <> 'owner@company.com'))
);

DELETE FROM "quo_webhook_deliveries" WHERE "company_id" IN (
  SELECT c."id" FROM "companies" c
  WHERE c."id" IN (60, 61)
    AND c."owner_user_id" IN ('user_3HW7oKOVVPPUX1aEW7XeCxRWfX4', 'user_3HWRMQy3sMmshdiliMsuCqpaisp')
    AND NOT EXISTS (SELECT 1 FROM "bookings" b WHERE b."company_id" = c."id")
    AND NOT EXISTS (SELECT 1 FROM "calls" k WHERE k."company_id" = c."id")
    AND NOT EXISTS (SELECT 1 FROM "team_members" t WHERE t."company_id" = c."id"
      AND (t."clerk_user_id" IS NOT NULL OR t."email" <> 'owner@company.com'))
);

DELETE FROM "quo_webhooks" WHERE "company_id" IN (
  SELECT c."id" FROM "companies" c
  WHERE c."id" IN (60, 61)
    AND c."owner_user_id" IN ('user_3HW7oKOVVPPUX1aEW7XeCxRWfX4', 'user_3HWRMQy3sMmshdiliMsuCqpaisp')
    AND NOT EXISTS (SELECT 1 FROM "bookings" b WHERE b."company_id" = c."id")
    AND NOT EXISTS (SELECT 1 FROM "calls" k WHERE k."company_id" = c."id")
    AND NOT EXISTS (SELECT 1 FROM "team_members" t WHERE t."company_id" = c."id"
      AND (t."clerk_user_id" IS NOT NULL OR t."email" <> 'owner@company.com'))
);

DELETE FROM "homeowner_pins" WHERE "company_id" IN (
  SELECT c."id" FROM "companies" c
  WHERE c."id" IN (60, 61)
    AND c."owner_user_id" IN ('user_3HW7oKOVVPPUX1aEW7XeCxRWfX4', 'user_3HWRMQy3sMmshdiliMsuCqpaisp')
    AND NOT EXISTS (SELECT 1 FROM "bookings" b WHERE b."company_id" = c."id")
    AND NOT EXISTS (SELECT 1 FROM "calls" k WHERE k."company_id" = c."id")
    AND NOT EXISTS (SELECT 1 FROM "team_members" t WHERE t."company_id" = c."id"
      AND (t."clerk_user_id" IS NOT NULL OR t."email" <> 'owner@company.com'))
);

DELETE FROM "cleaner_locations" WHERE "company_id" IN (
  SELECT c."id" FROM "companies" c
  WHERE c."id" IN (60, 61)
    AND c."owner_user_id" IN ('user_3HW7oKOVVPPUX1aEW7XeCxRWfX4', 'user_3HWRMQy3sMmshdiliMsuCqpaisp')
    AND NOT EXISTS (SELECT 1 FROM "bookings" b WHERE b."company_id" = c."id")
    AND NOT EXISTS (SELECT 1 FROM "calls" k WHERE k."company_id" = c."id")
    AND NOT EXISTS (SELECT 1 FROM "team_members" t WHERE t."company_id" = c."id"
      AND (t."clerk_user_id" IS NOT NULL OR t."email" <> 'owner@company.com'))
);

DELETE FROM "team_members" WHERE "company_id" IN (
  SELECT c."id" FROM "companies" c
  WHERE c."id" IN (60, 61)
    AND c."owner_user_id" IN ('user_3HW7oKOVVPPUX1aEW7XeCxRWfX4', 'user_3HWRMQy3sMmshdiliMsuCqpaisp')
    AND NOT EXISTS (SELECT 1 FROM "bookings" b WHERE b."company_id" = c."id")
    AND NOT EXISTS (SELECT 1 FROM "calls" k WHERE k."company_id" = c."id")
    AND NOT EXISTS (SELECT 1 FROM "team_members" t WHERE t."company_id" = c."id"
      AND (t."clerk_user_id" IS NOT NULL OR t."email" <> 'owner@company.com'))
);

DELETE FROM "companies" c
WHERE c."id" IN (60, 61)
  AND c."owner_user_id" IN ('user_3HW7oKOVVPPUX1aEW7XeCxRWfX4', 'user_3HWRMQy3sMmshdiliMsuCqpaisp')
  AND NOT EXISTS (SELECT 1 FROM "bookings" b WHERE b."company_id" = c."id")
  AND NOT EXISTS (SELECT 1 FROM "calls" k WHERE k."company_id" = c."id")
  AND NOT EXISTS (SELECT 1 FROM "team_members" t WHERE t."company_id" = c."id");
