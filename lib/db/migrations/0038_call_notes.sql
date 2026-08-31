-- IF NOT EXISTS on purpose: the Publish flow diffs dev schema into
-- production before this migration runs there, so boot must tolerate the
-- column already existing.
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "notes" text;