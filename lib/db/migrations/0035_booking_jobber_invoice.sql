ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "jobber_invoice_id" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "jobber_invoice_number" text;
