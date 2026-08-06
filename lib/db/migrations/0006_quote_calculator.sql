-- Price a job the way the owner actually does it: hours x crew rate, plus a
-- fuel surcharge, less any promo discount. Storing those inputs (rather than
-- only the resulting number) means reopening a quote shows the same choices
-- back, and the estimate's line items can be rebuilt from them exactly.
--
-- Replaces the free-form line-item list added in 0005, which was a second
-- source of truth for the same numbers.
--
-- Idempotent: safe on fresh databases and on any prior state.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "quote_rate_solo" double precision NOT NULL DEFAULT 52.5;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "quote_rate_team" double precision NOT NULL DEFAULT 105;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "quote_fuel_surcharge" double precision NOT NULL DEFAULT 12.5;

ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "quote_hours" double precision;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "quote_crew_label" text;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "quote_hourly_rate" double precision;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "quote_fuel_surcharge" double precision;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "quote_discount_amount" double precision;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "quote_referral_source" text;

ALTER TABLE "bookings" DROP COLUMN IF EXISTS "quote_line_items";
