-- Jobber's own web URL for the invoice created from a booking, captured at
-- creation time so "open the invoice" never has to guess how Jobber builds
-- its links. Null for invoices created before this column existed.
-- IF NOT EXISTS on purpose: the Publish flow diffs dev schema into
-- production before this migration runs there, so boot must tolerate the
-- column already existing.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "jobber_invoice_web_uri" text;
