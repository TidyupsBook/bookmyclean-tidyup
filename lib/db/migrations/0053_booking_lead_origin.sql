-- Which lead a booking came out of, when it came out of one.
--
-- The leads inbox already records the link the other way round
-- (leads.converted_booking_id), so why a column here too: a booking pushes
-- itself to Jobber the instant it is saved, which is before the inbox has
-- recorded the conversion. The push has to know at that moment that this
-- customer arrived from an ad, because a lead must always become a NEW Jobber
-- client rather than being matched onto an existing one by phone number. The
-- owner merges duplicates inside Jobber, where a merge is visible and
-- reversible; a silent match here is neither.
--
-- Guarded on purpose: task merges renumber migration files and Publish may
-- pre-apply DDL, so all of this must succeed on a database that already has it.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "lead_id" integer;

-- Deliberately no foreign key. This is a historical marker — "this customer
-- arrived from an ad" — not a live relationship, and a foreign key offers only
-- two bad endings for it. ON DELETE SET NULL quietly erases the marker, which
-- hands a later re-send straight back to phone matching: the one thing this
-- column exists to prevent. ON DELETE RESTRICT makes any future lead purge
-- fail, and a purge that runs inside a migration would take a publish down
-- with it. A lead id left pointing at a deleted lead is the smaller problem:
-- the fact survives, and the create route proves the id belongs to the
-- caller's company before it is ever stored.
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_lead_id_leads_id_fk";

CREATE INDEX IF NOT EXISTS "bookings_lead_id_idx" ON "bookings" ("lead_id");

-- Bookings converted from a lead before this column existed keep their origin,
-- so a later retry of their Jobber push follows the same rule as a new one.
UPDATE "bookings" b
SET "lead_id" = l."id"
FROM "leads" l
WHERE l."converted_booking_id" = b."id"
  AND b."lead_id" IS NULL;
