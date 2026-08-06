-- Staff details: phone, home address for the live map, a roster on/off switch,
-- and a lead-cleaner label. Email becomes optional because not everyone on a
-- cleaning crew signs in to the app.
ALTER TABLE "team_members" ALTER COLUMN "email" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "team_members" ADD COLUMN IF NOT EXISTS "phone" text;
--> statement-breakpoint
ALTER TABLE "team_members" ADD COLUMN IF NOT EXISTS "is_lead" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "team_members" ADD COLUMN IF NOT EXISTS "active" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "team_members" ADD COLUMN IF NOT EXISTS "home_address" text;
--> statement-breakpoint
ALTER TABLE "team_members" ADD COLUMN IF NOT EXISTS "home_lat" double precision;
--> statement-breakpoint
ALTER TABLE "team_members" ADD COLUMN IF NOT EXISTS "home_lng" double precision;
--> statement-breakpoint
ALTER TABLE "team_members" ADD COLUMN IF NOT EXISTS "home_geocoded_at" timestamp with time zone;
