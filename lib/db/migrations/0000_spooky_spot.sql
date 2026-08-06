CREATE TABLE "companies" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"greeting" text DEFAULT '' NOT NULL,
	"collect_fields" text[] DEFAULT '{}' NOT NULL,
	"custom_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ring_through_number" text,
	"phone_number" text,
	"jobber_connected" boolean DEFAULT false NOT NULL,
	"jobber_account_name" text,
	"jobber_account_id" text,
	"jobber_access_token" text,
	"jobber_refresh_token" text,
	"jobber_token_expires_at" timestamp with time zone,
	"jobber_oauth" jsonb,
	"quo_connected" boolean DEFAULT false NOT NULL,
	"quo_workspace_name" text,
	"quo_number_ids" text[] DEFAULT '{}' NOT NULL,
	"quo_api_key_encrypted" text,
	"quo_key_last4" text,
	"receptionist_configured" boolean DEFAULT false NOT NULL,
	"is_live" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_owner_user_id_unique" UNIQUE("owner_user_id")
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_min" double precision,
	"price_max" double precision,
	"duration_minutes" integer
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"caller_name" text NOT NULL,
	"caller_phone" text NOT NULL,
	"status" text NOT NULL,
	"service_requested" text,
	"preferred_time" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extracted_answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"booking_id" integer,
	"quo_call_id" text,
	"quo_phone_number_id" text,
	"direction" text,
	"summary" text,
	"recording_url" text,
	CONSTRAINT "calls_quo_call_id_unique" UNIQUE("quo_call_id")
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"call_id" integer,
	"customer_name" text NOT NULL,
	"customer_phone" text NOT NULL,
	"customer_address" text,
	"service" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"jobber_synced" boolean DEFAULT false NOT NULL,
	"jobber_job_id" text,
	"jobber_client_id" text,
	"jobber_web_uri" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_call_id_unique" UNIQUE("call_id")
);
--> statement-breakpoint
CREATE TABLE "activity" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quo_webhook_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"company_id" integer NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quo_webhook_deliveries_delivery_id_unique" UNIQUE("delivery_id")
);
--> statement-breakpoint
CREATE TABLE "quo_webhooks" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"quo_webhook_id" text NOT NULL,
	"signing_key" text NOT NULL,
	"events" text[] DEFAULT '{}' NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quo_webhooks_quo_webhook_id_unique" UNIQUE("quo_webhook_id")
);
--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quo_webhook_deliveries" ADD CONSTRAINT "quo_webhook_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quo_webhooks" ADD CONSTRAINT "quo_webhooks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;