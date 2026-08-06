-- Let a customer pay their deposit online from the quote page.
--
-- deposit_paid_at is only ever written after Stripe confirms the session was
-- paid, never on the redirect back from Checkout — the customer controls that
-- URL and could otherwise mark their own deposit as paid.
--
-- Idempotent: safe on fresh databases and on any prior state.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "deposit_checkout_session_id" text;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "deposit_paid_at" timestamp with time zone;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "deposit_paid_amount" double precision;
