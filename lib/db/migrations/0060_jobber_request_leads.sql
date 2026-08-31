-- Jobber-form requests land in the Leads inbox: new lead columns carry the
-- customer's own message and the ids Jobber already has, and a delivery
-- claim table makes the Jobber webhook idempotent (same shape as Quo's).
-- Idempotent throughout: task merges renumber migration files and Publish
-- can pre-apply DDL, so every statement here must survive a second run.

ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "message" text;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "jobber_request_id" text;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "jobber_client_id" text;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "jobber_property_id" text;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "jobber_web_uri" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobber_webhook_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"topic" text NOT NULL,
	"company_id" integer NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobber_webhook_deliveries_delivery_id_unique" UNIQUE("delivery_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "jobber_webhook_deliveries" ADD CONSTRAINT "jobber_webhook_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
