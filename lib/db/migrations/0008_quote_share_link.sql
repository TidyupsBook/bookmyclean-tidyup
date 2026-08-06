-- Give each quote a shareable customer-facing page.
--
-- quote_token is the customer's key to their own quote: the page has to be
-- public (they are reading a text on their phone, not signing in), so the
-- token is the authorisation. UNIQUE so a collision fails loudly rather than
-- serving one customer another customer's quote.
--
-- Idempotent: safe on fresh databases and on any prior state.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "quote_token" text;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "quote_approved_at" timestamp with time zone;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_quote_token_unique'
  ) THEN
    ALTER TABLE "bookings" ADD CONSTRAINT "bookings_quote_token_unique" UNIQUE ("quote_token");
  END IF;
END $$;
