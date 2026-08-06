-- Freeze the numbers at the moment a quote is texted.
--
-- Totals are otherwise derived from the company's current rates, which keeps a
-- quote internally consistent. But once a price has been sent to a customer it
-- is a commitment: if the owner later edits their tax rate, the dashboard must
-- still show what was actually promised rather than silently repricing it.
--
-- Idempotent: safe on fresh databases and on any prior state.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "quote_sent_totals" jsonb;
