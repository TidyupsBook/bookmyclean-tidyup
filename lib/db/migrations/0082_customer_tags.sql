ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "tag" text;
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "tag" text;
ALTER TABLE "jobber_invoices" ADD COLUMN IF NOT EXISTS "tag" text;