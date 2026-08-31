-- Whether a seat may take a booking off a live call. Idempotent: task merges
-- renumber files and Publish may pre-apply columns, so this must re-run clean.
ALTER TABLE "team_members" ADD COLUMN IF NOT EXISTS "live_call_dispatching" boolean NOT NULL DEFAULT false;
