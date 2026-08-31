-- Keep the latest per-tab outcome so partial sheet syncs are explainable.
ALTER TABLE "lead_sync_state"
  ADD COLUMN IF NOT EXISTS "tab_statuses" jsonb NOT NULL DEFAULT '[]'::jsonb;