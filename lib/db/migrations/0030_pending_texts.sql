-- Texts the app still owes somebody (owner nudges, join-request verdicts).
-- The row is the retry state: claimed by delete, re-inserted on send failure,
-- swept by the hourly health check until it actually goes out.
CREATE TABLE IF NOT EXISTS "pending_texts" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL,
  "to_phone" text,
  "kind" text NOT NULL,
  "content" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "pending_texts" ADD CONSTRAINT "pending_texts_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id");
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
