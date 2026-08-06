-- Everything the booking desk collects on the phone but had nowhere to go:
-- an email, the address broken into the boxes Jobber wants, the job scope
-- (bedrooms, bathrooms, extras), how often they want it, and crew-only entry
-- notes. All nullable — a caller who won't answer still gets a booking, and
-- every booking taken before today keeps working untouched.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "customer_email" text;
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "address_city" text;
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "address_province" text;
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "address_postal" text;
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "bedrooms" integer;
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "bathrooms" integer;
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "extras" jsonb;
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "frequency" text;
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "internal_notes" text;
