-- Inbound Jobber requests & quotes as pending bookings.
-- Idempotent throughout: task merges renumber migration files and Publish can
-- pre-apply columns, so every statement here must survive a second run.

ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "jobber_synced_request_id" text;
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "jobber_synced_quote_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bookings_company_jobber_synced_request_idx"
ON "bookings" ("company_id","jobber_synced_request_id") WHERE "jobber_synced_request_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bookings_company_jobber_synced_quote_idx"
ON "bookings" ("company_id","jobber_synced_quote_id") WHERE "jobber_synced_quote_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "jobber_requests_synced_through" timestamp with time zone;
