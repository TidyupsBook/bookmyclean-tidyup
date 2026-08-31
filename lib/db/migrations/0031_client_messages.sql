-- Two-way texting with customers: one thread per customer number per company,
-- and every message in or out. The unique Quo message id is what stops a
-- redelivered webhook writing the same customer text twice.
CREATE TABLE IF NOT EXISTS "client_threads" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL,
  "customer_phone" text NOT NULL,
  "customer_name" text,
  "last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_message_preview" text,
  "last_direction" text,
  "unread_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_messages" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL,
  "thread_id" integer NOT NULL,
  "direction" text NOT NULL,
  "body" text NOT NULL,
  "quo_message_id" text,
  "sent_by_name" text,
  "status" text DEFAULT 'sent' NOT NULL,
  "error_text" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "client_threads" ADD CONSTRAINT "client_threads_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id");
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "client_threads" ADD CONSTRAINT "client_threads_company_phone_key"
    UNIQUE ("company_id", "customer_phone");
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "client_messages" ADD CONSTRAINT "client_messages_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id");
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "client_messages" ADD CONSTRAINT "client_messages_thread_id_client_threads_id_fk"
    FOREIGN KEY ("thread_id") REFERENCES "client_threads"("id");
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "client_messages" ADD CONSTRAINT "client_messages_quo_message_id_unique"
    UNIQUE ("quo_message_id");
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_threads_company_activity_idx"
  ON "client_threads" ("company_id", "last_message_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_messages_thread_idx"
  ON "client_messages" ("thread_id", "created_at");
