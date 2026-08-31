-- Owner-tunable window (minutes) for how long the mobile "Take booking"
-- shortcut stays on a finished call. Idempotent — task merges renumber files
-- and Publish can pre-apply columns, so this must survive a re-run.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "recent_call_window_minutes" integer NOT NULL DEFAULT 30;
