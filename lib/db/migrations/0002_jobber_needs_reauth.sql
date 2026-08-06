-- Track when a company's Jobber tokens are known-dead (refresh rejected or
-- APP_DISCONNECT webhook received) so the UI can prompt a reconnect.
-- Idempotent: safe on fresh databases and on any prior state.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "jobber_needs_reauth" boolean NOT NULL DEFAULT false;
