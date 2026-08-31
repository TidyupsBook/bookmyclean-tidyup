-- In-app chat between staff: direct threads and groups, membership by seat,
-- and a read watermark per person so unread counts can't drift.
CREATE TABLE IF NOT EXISTS "staff_conversations" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL,
  "kind" text DEFAULT 'direct' NOT NULL,
  "title" text,
  "direct_key" text,
  "created_by_member_id" integer,
  "last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_message_preview" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_conversation_members" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL,
  "conversation_id" integer NOT NULL,
  "member_id" integer NOT NULL,
  "last_read_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_messages" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL,
  "conversation_id" integer NOT NULL,
  "member_id" integer NOT NULL,
  "author_name" text NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'staff_conversations_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "staff_conversations"
      ADD CONSTRAINT "staff_conversations_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "companies"("id");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'staff_conversations_created_by_member_id_team_members_id_fk'
  ) THEN
    ALTER TABLE "staff_conversations"
      ADD CONSTRAINT "staff_conversations_created_by_member_id_team_members_id_fk"
      FOREIGN KEY ("created_by_member_id") REFERENCES "team_members"("id");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'staff_conversation_members_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "staff_conversation_members"
      ADD CONSTRAINT "staff_conversation_members_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "companies"("id");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'staff_conversation_members_conversation_id_fk'
  ) THEN
    ALTER TABLE "staff_conversation_members"
      ADD CONSTRAINT "staff_conversation_members_conversation_id_fk"
      FOREIGN KEY ("conversation_id") REFERENCES "staff_conversations"("id");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'staff_conversation_members_member_id_team_members_id_fk'
  ) THEN
    ALTER TABLE "staff_conversation_members"
      ADD CONSTRAINT "staff_conversation_members_member_id_team_members_id_fk"
      FOREIGN KEY ("member_id") REFERENCES "team_members"("id");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'staff_messages_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "staff_messages"
      ADD CONSTRAINT "staff_messages_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "companies"("id");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'staff_messages_conversation_id_fk'
  ) THEN
    ALTER TABLE "staff_messages"
      ADD CONSTRAINT "staff_messages_conversation_id_fk"
      FOREIGN KEY ("conversation_id") REFERENCES "staff_conversations"("id");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'staff_messages_member_id_team_members_id_fk'
  ) THEN
    ALTER TABLE "staff_messages"
      ADD CONSTRAINT "staff_messages_member_id_team_members_id_fk"
      FOREIGN KEY ("member_id") REFERENCES "team_members"("id");
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_conversations_direct_key"
  ON "staff_conversations" ("company_id", "direct_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_conversations_company_activity_idx"
  ON "staff_conversations" ("company_id", "last_message_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_conversation_members_unique"
  ON "staff_conversation_members" ("conversation_id", "member_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_conversation_members_member_idx"
  ON "staff_conversation_members" ("company_id", "member_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_messages_conversation_idx"
  ON "staff_messages" ("conversation_id", "created_at");
