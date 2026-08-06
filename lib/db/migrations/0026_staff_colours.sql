-- A chosen colour per staff member, drawn on the schedule blocks, the crew
-- legend and the map pins. Null keeps the automatic hue derived from the row
-- id, so existing staff are unaffected until someone picks something.
ALTER TABLE "team_members" ADD COLUMN IF NOT EXISTS "color" text;
