-- Schedule, map, and dashboard queries all filter bookings by company and a
-- scheduled_for window, and the dashboard filters calls by company and a
-- started_at window. History is now kept forever, so without these indexes
-- every one of those queries scans an ever-growing table.
-- Idempotent: task merges renumber migrations and Publish may pre-apply.
CREATE INDEX IF NOT EXISTS "bookings_company_scheduled_for_idx" ON "bookings" ("company_id", "scheduled_for");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calls_company_started_at_idx" ON "calls" ("company_id", "started_at");
