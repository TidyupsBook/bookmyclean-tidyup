-- Google's boilerplate sample lead (id ends in the literal `SaMple`, its
-- documented test-lead marker) imported fully populated once the long-form
-- headers were mapped, and sat on the Leads page looking real. New syncs now
-- skip it at import; this cleans up rows already imported.
--
-- Case-sensitive LIKE on purpose: real gclids are case-significant and never
-- end in that exact six-character casing. No child tables reference leads,
-- so the delete is self-contained, and re-running it is a no-op.
DELETE FROM "leads" WHERE "sheet_lead_id" LIKE '%SaMple';
