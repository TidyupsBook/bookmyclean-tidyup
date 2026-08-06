-- Track when Quo rejects a company's API key (401/403) so the dashboard can
-- warn the owner and point them at reconnecting, instead of failing silently.
-- Idempotent: safe on fresh databases and on any prior state.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "quo_needs_reauth" boolean NOT NULL DEFAULT false;
