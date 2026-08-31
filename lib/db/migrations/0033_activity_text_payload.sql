-- "text_given_up" activity entries carry the dropped text's recipient, kind
-- and content so the owner can re-queue it with one tap. Nulled once a resend
-- is claimed.
ALTER TABLE "activity" ADD COLUMN IF NOT EXISTS "text_payload" jsonb;
