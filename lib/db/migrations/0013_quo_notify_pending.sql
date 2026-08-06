-- Owner text still owed for the last Quo connection transition ("dead" or
-- "restored", NULL when none). Decouples "the quoNeedsReauth flag is accurate"
-- from "the notification still needs to go out", so the dashboard warning can
-- flip immediately while a failed text keeps being retried.
-- Idempotent: safe on fresh databases and on any prior state.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "quo_notify_pending" text;
