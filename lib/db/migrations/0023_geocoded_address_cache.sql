CREATE TABLE IF NOT EXISTS "geocoded_addresses" (
  "id" serial PRIMARY KEY NOT NULL,
  "address_key" text NOT NULL,
  "lat" double precision,
  "lng" double precision,
  "attempts" integer DEFAULT 0 NOT NULL,
  "checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "geocoded_addresses_address_key_unique" ON "geocoded_addresses" ("address_key");
