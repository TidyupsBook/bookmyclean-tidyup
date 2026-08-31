-- An exceptional destructive repair needs durable evidence independent of the
-- company rows it removes. The unique repair key makes a reviewed cleanup
-- one-shot even if the authenticated request is retried.
CREATE TABLE IF NOT EXISTS "company_repair_audits" (
  "id" serial PRIMARY KEY NOT NULL,
  "repair_key" text NOT NULL,
  "performed_by" text NOT NULL,
  "review_digest" text NOT NULL,
  "target_company_ids" integer[] NOT NULL,
  "before_snapshot" jsonb NOT NULL,
  "after_snapshot" jsonb NOT NULL,
  "completed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "company_repair_audits_repair_key_unique" UNIQUE("repair_key")
);