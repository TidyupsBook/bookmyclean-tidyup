-- Preserve a safe company-owned source reference through retries so an owner
-- can optionally correct the originating record after a text gives up.
ALTER TABLE "pending_texts"
  ADD COLUMN IF NOT EXISTS "source" jsonb;