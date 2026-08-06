-- Fallback number for owner outage/recovery texts. When a company has no
-- ring-through number, outage notifications were silently skipped; this gives
-- the owner a dedicated place to receive them.
-- Idempotent: safe on fresh databases and on any prior state.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "notification_number" text;
