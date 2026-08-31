-- Optional apartment, suite, or unit line for booking addresses.
-- IF NOT EXISTS keeps this safe when a deployment pre-applies the DDL.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "address_line_2" text;