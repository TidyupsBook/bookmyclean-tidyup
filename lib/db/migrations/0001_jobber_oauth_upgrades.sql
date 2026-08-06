-- Upgrade existing databases to include Jobber OAuth token columns,
-- Quo integration columns, and all Jobber booking fields.
-- All statements use IF NOT EXISTS / IF EXISTS so this migration is safe to
-- run against any state: fresh databases (0000 already created all columns,
-- ADD COLUMN IF NOT EXISTS is a no-op), and databases created before any of
-- these features were added.
--
-- NOTE: Do not rely on any baseline mechanism for this migration. Because
-- every statement is idempotent, it is always safe to let migrate() run it.

-- Jobber company fields (simulated-era columns that may be missing on old DBs)
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "jobber_connected" boolean NOT NULL DEFAULT false;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "jobber_account_name" text;

-- Jobber OAuth token storage (added by real Jobber integration)
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "jobber_account_id" text;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "jobber_access_token" text;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "jobber_refresh_token" text;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "jobber_token_expires_at" timestamp with time zone;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "jobber_oauth" jsonb;

-- Quo integration columns on companies
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "quo_connected" boolean NOT NULL DEFAULT false;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "quo_workspace_name" text;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "quo_number_ids" text[] NOT NULL DEFAULT '{}';
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "quo_api_key_encrypted" text;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "quo_key_last4" text;

-- Other optional company fields
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "ring_through_number" text;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "phone_number" text;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "receptionist_configured" boolean NOT NULL DEFAULT false;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "is_live" boolean NOT NULL DEFAULT false;

-- Booking Jobber sync fields (simulated-era + real integration)
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "call_id" integer;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "customer_address" text;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "jobber_synced" boolean NOT NULL DEFAULT false;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "jobber_job_id" text;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "jobber_client_id" text;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "jobber_web_uri" text;

-- Unique constraint for bookings.call_id (if not already present)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_call_id_unique'
  ) THEN
    ALTER TABLE "bookings" ADD CONSTRAINT "bookings_call_id_unique" UNIQUE ("call_id");
  END IF;
END $$;

-- Quo call metadata on calls
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "service_requested" text;
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "preferred_time" text;
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "is_test" boolean NOT NULL DEFAULT false;
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "transcript" jsonb NOT NULL DEFAULT '[]';
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "extracted_answers" jsonb NOT NULL DEFAULT '[]';
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "booking_id" integer;
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "quo_call_id" text;
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "quo_phone_number_id" text;
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "direction" text;
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "summary" text;
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "recording_url" text;

-- Unique constraint for calls.quo_call_id (if not already present)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'calls_quo_call_id_unique'
  ) THEN
    ALTER TABLE "calls" ADD CONSTRAINT "calls_quo_call_id_unique" UNIQUE ("quo_call_id");
  END IF;
END $$;

-- Services optional pricing fields
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "price_min" double precision;
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "price_max" double precision;
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "duration_minutes" integer;

-- Quo webhook tracking tables (created only if missing)
CREATE TABLE IF NOT EXISTS "quo_webhook_deliveries" (
  "id" serial PRIMARY KEY NOT NULL,
  "delivery_id" text NOT NULL,
  "event_type" text NOT NULL,
  "company_id" integer NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "quo_webhook_deliveries_delivery_id_unique" UNIQUE ("delivery_id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quo_webhook_deliveries_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "quo_webhook_deliveries" ADD CONSTRAINT "quo_webhook_deliveries_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "quo_webhooks" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL,
  "quo_webhook_id" text NOT NULL,
  "signing_key" text NOT NULL,
  "events" text[] DEFAULT '{}' NOT NULL,
  "url" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "quo_webhooks_quo_webhook_id_unique" UNIQUE ("quo_webhook_id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quo_webhooks_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "quo_webhooks" ADD CONSTRAINT "quo_webhooks_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");
  END IF;
END $$;
