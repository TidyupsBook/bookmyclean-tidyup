-- Link a call-source lead back to the call it was created from.
-- Nullable FK — only call-source leads set this; sheet/form/jobber leads
-- leave it null. Idempotent on purpose: task merges renumber files and
-- Publish can pre-apply columns, so ALTERs may run more than once.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "call_id" integer REFERENCES "calls"("id");
