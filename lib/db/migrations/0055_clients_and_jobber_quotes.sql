-- Client directory + Jobber quote mirror.
-- Idempotent throughout: task merges renumber migration files and Publish can
-- pre-apply columns, so every statement here must survive a second run.

CREATE TABLE IF NOT EXISTS "clients" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"phone_e164" text,
	"email" text,
	"street_address" text,
	"city" text,
	"province" text,
	"postal_code" text,
	"jobber_client_id" text,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "clients" ADD CONSTRAINT "clients_company_id_companies_id_fk"
		FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "clients_company_phone_e164_uq"
	ON "clients" ("company_id","phone_e164") WHERE "phone_e164" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "clients_company_jobber_client_uq"
	ON "clients" ("company_id","jobber_client_id") WHERE "jobber_client_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clients_company_idx" ON "clients" ("company_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobber_quotes" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"jobber_quote_id" text NOT NULL,
	"quote_number" integer,
	"title" text,
	"client_name" text,
	"client_phone" text,
	"jobber_client_id" text,
	"property_address" text,
	"status" text NOT NULL,
	"total_cents" integer,
	"jobber_web_uri" text,
	"jobber_created_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"transitioned_at" timestamp with time zone,
	"jobber_updated_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "jobber_quotes" ADD CONSTRAINT "jobber_quotes_company_id_companies_id_fk"
		FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "jobber_quotes_company_quote_uq"
	ON "jobber_quotes" ("company_id","jobber_quote_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobber_quotes_company_idx" ON "jobber_quotes" ("company_id");
--> statement-breakpoint
-- Quote-pull cursor; only a complete pull advances it (see companies schema).
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "jobber_quotes_synced_through" timestamp with time zone;
--> statement-breakpoint
-- Backfill: every customer already on a booking becomes a client row, newest
-- booking's details winning, any known Jobber client id kept. The phone
-- normalization mirrors toE164() in the API server (NA 10/11-digit first,
-- then any 8-15 digit international number not starting with 0). Guarded by
-- NOT EXISTS + ON CONFLICT DO NOTHING so a re-run inserts nothing.
WITH normalized AS (
	SELECT
		b.*,
		CASE
			WHEN length(regexp_replace(b."customer_phone", '\D', '', 'g')) = 10
				THEN '+1' || regexp_replace(b."customer_phone", '\D', '', 'g')
			WHEN length(regexp_replace(b."customer_phone", '\D', '', 'g')) = 11
				AND regexp_replace(b."customer_phone", '\D', '', 'g') LIKE '1%'
				THEN '+' || regexp_replace(b."customer_phone", '\D', '', 'g')
			WHEN length(regexp_replace(b."customer_phone", '\D', '', 'g')) BETWEEN 8 AND 15
				AND regexp_replace(b."customer_phone", '\D', '', 'g') NOT LIKE '0%'
				THEN '+' || regexp_replace(b."customer_phone", '\D', '', 'g')
			ELSE NULL
		END AS e164
	FROM "bookings" b
	WHERE b."customer_name" IS NOT NULL AND btrim(b."customer_name") <> ''
		-- A "phone" with no digit ("Unknown", "N/A", NULL) identifies nobody;
		-- also keeps the NOT EXISTS guard sound (NULL phones never compare equal).
		AND b."customer_phone" ~ '[0-9]'
), grouped AS (
	SELECT
		n."company_id",
		n.e164,
		(array_agg(n."customer_name" ORDER BY n."created_at" DESC))[1] AS name,
		(array_agg(n."customer_phone" ORDER BY n."created_at" DESC))[1] AS phone,
		(array_agg(n."customer_email" ORDER BY n."created_at" DESC)
			FILTER (WHERE n."customer_email" IS NOT NULL AND n."customer_email" <> ''))[1] AS email,
		(array_agg(n."customer_address" ORDER BY n."created_at" DESC)
			FILTER (WHERE n."customer_address" IS NOT NULL AND n."customer_address" <> ''))[1] AS street_address,
		(array_agg(n."address_city" ORDER BY n."created_at" DESC)
			FILTER (WHERE n."address_city" IS NOT NULL AND n."address_city" <> ''))[1] AS city,
		(array_agg(n."address_province" ORDER BY n."created_at" DESC)
			FILTER (WHERE n."address_province" IS NOT NULL AND n."address_province" <> ''))[1] AS province,
		(array_agg(n."address_postal" ORDER BY n."created_at" DESC)
			FILTER (WHERE n."address_postal" IS NOT NULL AND n."address_postal" <> ''))[1] AS postal_code,
		(array_agg(n."jobber_client_id" ORDER BY n."created_at" DESC)
			FILTER (WHERE n."jobber_client_id" IS NOT NULL))[1] AS jobber_client_id,
		MIN(n."created_at") AS first_seen_at
	FROM normalized n
	GROUP BY n."company_id", COALESCE(n.e164, n."customer_phone"), n.e164
)
INSERT INTO "clients"
	("company_id", "name", "phone", "phone_e164", "email", "street_address",
	 "city", "province", "postal_code", "jobber_client_id", "source", "created_at")
SELECT
	g."company_id", g.name, g.phone, g.e164, g.email, g.street_address,
	g.city, g.province, g.postal_code, g.jobber_client_id, 'booking',
	COALESCE(g.first_seen_at, now())
FROM grouped g
WHERE NOT EXISTS (
	SELECT 1 FROM "clients" c
	WHERE c."company_id" = g."company_id"
		AND (c."phone_e164" = g.e164 OR (g.e164 IS NULL AND c."phone" = g.phone))
)
ON CONFLICT DO NOTHING;
