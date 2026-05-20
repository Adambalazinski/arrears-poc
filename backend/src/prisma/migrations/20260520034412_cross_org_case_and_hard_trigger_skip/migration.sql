-- Two unrelated bug fixes bundled per the commit they ship with.
--
-- 1. Cross-org case unique. The original partial unique index
--    one_active_case_per_tenancy is global, so swapping workspaces
--    during local testing fails with a Prisma unique-violation as
--    soon as the new org tries to claim a tenancyId that the old org
--    still owns. Per-org partial unique is the correct invariant:
--    in real upstream data a tenancy belongs to one Rentancy
--    organisation (UUID-keyed), so this never gets hit in production.
--
-- 2. ChaseSkippedReason gets a HARD_TRIGGER_ESCALATION value. The
--    inbound hard-trigger handler currently writes BREATHING_SPACE_ACTIVE
--    as the skip reason for every trigger (hardship, mental health,
--    etc.), which lies in the audit trail. The handler will use the
--    correct value going forward — see the InboundPipelineService
--    change in the same commit.

DROP INDEX IF EXISTS "one_active_case_per_tenancy";

CREATE UNIQUE INDEX "one_active_case_per_org_tenancy"
  ON "case" ("organisationId", "tenancyId")
  WHERE status = 'ACTIVE';

ALTER TYPE "ChaseSkippedReason" ADD VALUE IF NOT EXISTS 'HARD_TRIGGER_ESCALATION';
