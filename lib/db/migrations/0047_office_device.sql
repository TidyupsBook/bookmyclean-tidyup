-- The office is a place, not a crew member: one device per company may be
-- flagged as the office, and its marker is parked on the company's stored
-- office location instead of the browser's last geolocation fix.
ALTER TABLE "staff_devices" ADD COLUMN IF NOT EXISTS "is_office" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "office_address" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "office_lat" double precision;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "office_lng" double precision;
