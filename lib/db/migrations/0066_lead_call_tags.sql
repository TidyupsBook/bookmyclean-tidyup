-- The owner's quick verdict on a lead or a call: client | good_lead |
-- bad_lead | spam. Nullable — untagged is the default state.
-- Idempotent on purpose: task merges renumber files and Publish can
-- pre-apply columns, so ALTERs may run more than once.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "tag" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "tag" text;
