-- Multi-Jobber-account support: one connection row per OAuth grant per company.
-- Seeds existing single-connection companies from the companies table columns.
-- Adds jobber_connection_id to team_members so staff can be routed to the
-- right Jobber account. Adds roster_capacity to companies (default 20).
-- Every ALTER is idempotent so task-merge re-runs are safe.

CREATE TABLE IF NOT EXISTS "jobber_connections" (
  "id" serial PRIMARY KEY,
  "company_id" integer NOT NULL REFERENCES "companies"("id"),
  "display_name" text,
  "account_id" text,
  "account_name" text,
  "access_token" text,
  "refresh_token" text,
  "token_expires_at" timestamptz,
  "needs_reauth" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Seed one row from each company that already had Jobber connected.
-- Idempotent: skipped when a row for that company already exists.
INSERT INTO "jobber_connections"
  ("company_id", "account_id", "account_name", "access_token", "refresh_token",
   "token_expires_at", "needs_reauth")
SELECT
  id,
  jobber_account_id,
  jobber_account_name,
  jobber_access_token,
  jobber_refresh_token,
  jobber_token_expires_at,
  jobber_needs_reauth
FROM "companies"
WHERE jobber_connected = true
  AND NOT EXISTS (
    SELECT 1 FROM "jobber_connections" jc WHERE jc.company_id = companies.id
  );

-- Which Jobber connection this staff member is assigned to. Nullable —
-- unassigned staff fall back to whatever single connection exists, exactly
-- as before multi-account support. Added idempotently.
ALTER TABLE "team_members"
  ADD COLUMN IF NOT EXISTS "jobber_connection_id" integer
  REFERENCES "jobber_connections"("id");

-- Auto-assign already Jobber-linked staff to their company's primary
-- connection row (the one just seeded above). Idempotent: only touches
-- rows that are linked but not yet assigned.
UPDATE "team_members" tm
SET jobber_connection_id = jc.id
FROM "jobber_connections" jc
WHERE jc.company_id = tm.company_id
  AND tm.jobber_user_id IS NOT NULL
  AND tm.jobber_connection_id IS NULL;

-- Roster capacity: how many slots (filled + open) the Team page shows.
-- Default 20 matches the "15 Jobber staff + 5 open" model the owner described.
ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "roster_capacity" integer NOT NULL DEFAULT 20;
