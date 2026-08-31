-- Short code the crew types at sign-up so their request reaches the right
-- company. Nullable: generated lazily the first time an owner looks at it.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "join_code" text;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "companies" ADD CONSTRAINT "companies_join_code_unique" UNIQUE ("join_code");
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
END $$;
