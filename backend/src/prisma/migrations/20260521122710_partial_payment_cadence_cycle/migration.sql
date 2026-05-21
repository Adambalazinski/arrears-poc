-- Partial-payment cadence cycle (R8.2 post-MVP).
--
-- Each partial payment can reset or step-back the chase cadence. To let the
-- same stage re-fire in a fresh cycle without colliding with the old entry,
-- ChaseScheduleEntry's unique index now includes the cycle the entry belongs
-- to. Charge.cadenceCycle increments on each reset / step-back; the chase
-- tick stamps new entries with the charge's current cycle.
--
-- Charge.cadenceAnchorAt, when set, overrides dueDate as the working-day
-- overdue anchor — used to position a charge at the intended stage right
-- after a partial payment.

ALTER TABLE "charge"
  ADD COLUMN "cadenceCycle"     INTEGER  NOT NULL DEFAULT 0,
  ADD COLUMN "cadenceAnchorAt"  TIMESTAMP(3);

ALTER TABLE "chase_schedule_entry"
  ADD COLUMN "cadenceCycle" INTEGER NOT NULL DEFAULT 0;

-- Replace the old uniqueness (chargeId, stage, recipientRole) with one that
-- includes the cycle. Existing rows all sit in cycle 0, so the new index
-- is satisfied by their previous values.
ALTER TABLE "chase_schedule_entry"
  DROP CONSTRAINT "chase_schedule_entry_chargeId_stage_recipientRole_key";
CREATE UNIQUE INDEX "chase_schedule_entry_chargeId_cadenceCycle_stage_recipientRole_key"
  ON "chase_schedule_entry" ("chargeId", "cadenceCycle", "stage", "recipientRole");

-- New CaseEventKind variants for R8.2 transitions.
ALTER TYPE "CaseEventKind" ADD VALUE 'CHARGE_CADENCE_RESET';
ALTER TYPE "CaseEventKind" ADD VALUE 'CHARGE_CADENCE_STEPPED_BACK';
