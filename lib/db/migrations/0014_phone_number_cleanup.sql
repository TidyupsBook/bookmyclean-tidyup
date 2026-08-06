-- Raw phone values saved before E.164 validation existed that the startup
-- cleanup pass could not normalize. The live column is cleared (so outage
-- texts don't silently fail against an undialable number) and the original
-- value is preserved here so settings can tell the owner what was removed.
-- Idempotent: safe on fresh databases and on any prior state.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "ring_through_number_rejected" text;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "notification_number_rejected" text;
