CREATE TABLE IF NOT EXISTS "callers" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "phone" text NOT NULL,
  "phone_e164" text NOT NULL,
  "best_name" text NOT NULL,
  "first_call_at" timestamp with time zone NOT NULL,
  "latest_call_at" timestamp with time zone NOT NULL,
  "call_count" integer DEFAULT 0 NOT NULL,
  "client_id" integer REFERENCES "clients"("id") ON DELETE set null,
  "quo_contact_id" text,
  "quo_synced_at" timestamp with time zone,
  "quo_sync_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "caller_id" integer REFERENCES "callers"("id") ON DELETE set null;
CREATE UNIQUE INDEX IF NOT EXISTS "callers_company_phone_e164_uq" ON "callers" ("company_id", "phone_e164");
CREATE INDEX IF NOT EXISTS "callers_company_latest_call_idx" ON "callers" ("company_id", "latest_call_at");
CREATE INDEX IF NOT EXISTS "calls_caller_id_idx" ON "calls" ("caller_id");