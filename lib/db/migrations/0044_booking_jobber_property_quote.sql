ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "jobber_property_id" text;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "jobber_quote_id" text;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "jobber_quote_number" text;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "jobber_quote_web_uri" text;
