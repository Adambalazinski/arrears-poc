-- Phase 2: guarantor parallel chase track.
--
-- 1. Add recipientRole to chase_schedule_entry. Defaults to TENANT so
--    existing rows continue to represent tenant-track entries.
-- 2. Replace the old (chargeId, stage) unique with (chargeId, stage,
--    recipientRole) so the chase tick can emit one entry per recipient.
-- 3. Add per-stage guarantor templates to organisation_config. Defaults
--    are empty strings; orgs that want guarantor cadence configure them
--    via PATCH /organisations/:id/config.

ALTER TABLE "chase_schedule_entry"
  ADD COLUMN "recipientRole" "RecipientRole" NOT NULL DEFAULT 'TENANT';

ALTER TABLE "chase_schedule_entry" DROP CONSTRAINT IF EXISTS "chase_schedule_entry_chargeId_stage_key";
DROP INDEX IF EXISTS "chase_schedule_entry_chargeId_stage_key";

ALTER TABLE "chase_schedule_entry"
  ADD CONSTRAINT "chase_schedule_entry_chargeId_stage_recipientRole_key"
  UNIQUE ("chargeId", "stage", "recipientRole");

ALTER TABLE "organisation_config"
  ADD COLUMN "templateWd3Guarantor"  TEXT NOT NULL DEFAULT '',
  ADD COLUMN "templateWd5Guarantor"  TEXT NOT NULL DEFAULT '',
  ADD COLUMN "templateWd8Guarantor"  TEXT NOT NULL DEFAULT '',
  ADD COLUMN "templateWd14Guarantor" TEXT NOT NULL DEFAULT '';
