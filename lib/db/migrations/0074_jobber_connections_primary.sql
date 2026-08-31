-- Add isPrimary flag to jobber_connections so we know which connection
-- keeps companies.jobber_* in sync (the "primary").  Every existing row
-- was the only connection for its company, so all are promoted to primary.
ALTER TABLE jobber_connections
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT false;

-- Mark exactly one connection per company as primary (the oldest one).
-- At the time of migration each company has at most one connection, so
-- this simply flips every existing row to true.
UPDATE jobber_connections jc
SET is_primary = true
FROM (
  SELECT DISTINCT ON (company_id) id
  FROM jobber_connections
  ORDER BY company_id, created_at ASC, id ASC
) oldest
WHERE jc.id = oldest.id;
