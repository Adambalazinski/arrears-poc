-- Partial indexes from docs/canonical-data-model.md (Prisma doesn't support `WHERE`).

-- Exactly one ACTIVE case per tenancy.
CREATE UNIQUE INDEX one_active_case_per_tenancy
  ON "case" ("tenancyId")
  WHERE status = 'ACTIVE';

-- Charge overdue scan index for the cadence tick. Kept narrow so it doesn't
-- bloat with PAID / RECONCILED rows that the scheduler ignores.
CREATE INDEX charge_overdue_scan
  ON "charge" ("lastKnownStatus", "dueDate")
  WHERE "lastKnownStatus" IN ('UNPAID', 'PARTIALLY_PAID', 'PARTIALLY_RECONCILED');
