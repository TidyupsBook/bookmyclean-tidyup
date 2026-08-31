-- Which Jobber user a staff member IS.
--
-- Assignment sync between the app and Jobber has only ever had names to go
-- on, and names drift: a nickname on one side, a surname added on the other,
-- and the sync quietly stops colouring that cleaner's jobs. This column is
-- the durable answer — once an owner links (or the sync unambiguously
-- adopts) a Jobber user onto a seat, both sync directions key on the id and
-- names are free to change.
--
-- Identity only: nothing else about the person syncs through this link.
--
-- Guarded on purpose: task merges renumber migration files and Publish may
-- pre-apply DDL, so all of this must succeed on a database that already has it.
ALTER TABLE "team_members" ADD COLUMN IF NOT EXISTS "jobber_user_id" text;

-- One seat per Jobber user per company. Two staff members claiming the same
-- Jobber identity would make assignee matching nondeterministic; NULLs are
-- distinct in Postgres, so unlinked staff are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS "team_members_company_jobber_user_idx"
  ON "team_members" ("company_id", "jobber_user_id");
