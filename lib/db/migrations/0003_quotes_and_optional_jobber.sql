-- Jobber becomes optional, and quoting/scheduling moves in-house so a company
-- that skips it can still price and book work.
--
-- `jobber_skipped` records a deliberate choice to run without Jobber, distinct
-- from "hasn't connected yet" — the setup wizard treats it as a resolved step.
--
-- `timezone` exists because quotes name an appointment time in customer-facing
-- text. Without it we would promise the customer a UTC hour.
--
-- Idempotent: safe on fresh databases and on any prior state.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "jobber_skipped" boolean NOT NULL DEFAULT false;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "timezone" text NOT NULL DEFAULT 'America/Edmonton';

ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "quoted_amount" double precision;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "quote_notes" text;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "quote_message" text;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "quote_sent_at" timestamp with time zone;
