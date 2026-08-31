-- Map pins for the Leads page: coordinates resolved by the shared geocode
-- backfill from the lead's raw sheet address.
--
-- Guarded on purpose: task merges renumber migration files and Publish may
-- pre-apply DDL, so these ALTERs must succeed on a database that already
-- has the columns.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "lat" double precision;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "lng" double precision;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "geocoded_at" timestamp with time zone;
