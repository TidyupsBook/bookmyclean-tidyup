ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "quo_contact_id" text;
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "quo_synced_at" timestamp with time zone;
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "quo_sync_error" text;