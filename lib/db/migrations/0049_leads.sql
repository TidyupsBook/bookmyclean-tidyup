-- Facebook/Instagram lead-ad rows synced from the leads Google Sheet, plus a
-- per-company record of when the sheet was last polled.
--
-- Guarded on purpose: task merges renumber migration files and Publish may
-- pre-apply DDL, so all of this has to succeed on a database that already
-- has it.
CREATE TABLE IF NOT EXISTS "leads" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL,
  "sheet_lead_id" text NOT NULL,
  "source_tab" text NOT NULL,
  "created_time" text,
  "campaign_name" text,
  "ad_name" text,
  "form_name" text,
  "platform" text,
  "service" text,
  "bedrooms" text,
  "bathrooms" text,
  "date_of_service_requested" text,
  "first_name" text,
  "last_name" text,
  "phone_number" text,
  "email" text,
  "street_address" text,
  "city" text,
  "province" text,
  "post_code" text,
  "inbox_url" text,
  "sheet_lead_status" text,
  "phone_e164" text,
  "status" text DEFAULT 'new' NOT NULL,
  "converted_booking_id" integer,
  "converted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_sync_state" (
  "company_id" integer PRIMARY KEY NOT NULL,
  "last_sync_at" timestamp with time zone,
  "last_success_at" timestamp with time zone,
  "last_error" text
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "leads" ADD CONSTRAINT "leads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "leads" ADD CONSTRAINT "leads_converted_booking_id_bookings_id_fk" FOREIGN KEY ("converted_booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "lead_sync_state" ADD CONSTRAINT "lead_sync_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "leads_company_sheet_lead_idx" ON "leads" USING btree ("company_id","sheet_lead_id");
