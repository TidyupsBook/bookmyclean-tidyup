-- Pin the verdict tags to the four allowed values (or null) at the database
-- level, so no import, backfill, or future code path can persist a value the
-- UI can't render. Drop-then-add so re-runs are harmless — task merges
-- renumber files and Publish can pre-apply, so DDL here must be idempotent.
ALTER TABLE "leads" DROP CONSTRAINT IF EXISTS "leads_tag_check";--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_tag_check" CHECK ("tag" IS NULL OR "tag" IN ('client', 'good_lead', 'bad_lead', 'spam'));--> statement-breakpoint
ALTER TABLE "calls" DROP CONSTRAINT IF EXISTS "calls_tag_check";--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_tag_check" CHECK ("tag" IS NULL OR "tag" IN ('client', 'good_lead', 'bad_lead', 'spam'));
