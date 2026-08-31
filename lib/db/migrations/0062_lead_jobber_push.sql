-- Form leads are pushed into Jobber as a new client + work request the
-- moment they are submitted, so the enquiry reaches the owner's CRM (via
-- Privyr picking it up from Jobber) without waiting for a booking. The id
-- columns themselves (jobber_request_id & co) arrived with the Jobber-form
-- lead import (0060) and are shared: `source` tells which way they
-- travelled. This migration adds what only the outbound push needs — the
-- synced flag and the last failure, so a Jobber outage is visible in the
-- inbox and retryable without losing the lead.
--
-- Guarded on purpose: task merges renumber migration files and Publish may
-- pre-apply DDL, so all of this must succeed on a database that already has it.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "jobber_synced" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "jobber_request_id" text;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "jobber_client_id" text;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "jobber_property_id" text;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "jobber_web_uri" text;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "jobber_push_error" text;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "jobber_push_error_at" timestamp with time zone;
