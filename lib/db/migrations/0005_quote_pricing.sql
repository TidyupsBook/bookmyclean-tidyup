-- Real quotes are itemised and carry the company's own tax and fees on top,
-- plus a deposit taken up front. Previously a quote was a single flat number,
-- which could not reproduce an actual estimate.
--
-- Rates live on the company because they are jurisdictional: Alberta's 5% GST
-- is not Ontario's 13% HST. Defaults are Tidyups' real numbers.
--
-- Idempotent: safe on fresh databases and on any prior state.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "quote_tax_label" text NOT NULL DEFAULT 'Alberta Tax';
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "quote_tax_rate" double precision NOT NULL DEFAULT 5;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "quote_fees_label" text NOT NULL DEFAULT 'Fees & Supplies';
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "quote_fees_rate" double precision NOT NULL DEFAULT 7.5;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "quote_deposit_amount" double precision NOT NULL DEFAULT 0;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "quote_deposit_email" text;

ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "quote_line_items" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "quote_deposit" double precision;
