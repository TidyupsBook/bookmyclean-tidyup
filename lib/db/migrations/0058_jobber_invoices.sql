-- Jobber invoice mirror: read-only rows pulled from Jobber so the dashboard
-- can show paid vs pending without opening Jobber, plus the pull cursor on
-- the company row. All DDL idempotent: task merges renumber files and
-- Publish pre-applies columns, so re-runs must be no-ops.
CREATE TABLE IF NOT EXISTS "jobber_invoices" (
"id" serial PRIMARY KEY NOT NULL,
"company_id" integer NOT NULL,
"jobber_invoice_id" text NOT NULL,
"invoice_number" text,
"subject" text,
"client_name" text,
"client_phone" text,
"jobber_client_id" text,
"property_address" text,
"status" text NOT NULL,
"total_cents" integer,
"balance_cents" integer,
"jobber_web_uri" text,
"issued_at" timestamp with time zone,
"due_at" timestamp with time zone,
"jobber_created_at" timestamp with time zone,
"jobber_updated_at" timestamp with time zone,
"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "jobber_invoices" ADD CONSTRAINT "jobber_invoices_company_id_companies_id_fk"
FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "jobber_invoices_company_invoice_uq"
ON "jobber_invoices" ("company_id","jobber_invoice_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobber_invoices_company_idx" ON "jobber_invoices" ("company_id");
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "jobber_invoices_synced_through" timestamp with time zone;
