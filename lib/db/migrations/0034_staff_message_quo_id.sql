-- A staff reply that arrives by text is written into the chat thread it was
-- answering. Quo redelivers webhooks, so the Quo message id is kept unique:
-- a second delivery loses the race instead of duplicating the reply.
ALTER TABLE "staff_messages" ADD COLUMN IF NOT EXISTS "quo_message_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_messages_quo_message_id_unique" ON "staff_messages" ("quo_message_id");
