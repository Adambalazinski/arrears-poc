-- Phase 2: payment promise workflow (CLAUDE.md item 10).
--
-- Tenant commits to pay by a date; while the promise is ACTIVE we
-- suspend both chase tracks (tenant + guarantor) and auto-reject
-- pending OUTBOUND drafts. On expiry without fulfillment a daily
-- job marks it BROKEN and drafts a broken-promise communication.

CREATE TYPE "PromiseStatus" AS ENUM ('ACTIVE', 'FULFILLED', 'BROKEN', 'CANCELLED');

CREATE TABLE "promise" (
  "id"                            TEXT NOT NULL,
  "caseId"                        TEXT NOT NULL,
  "status"                        "PromiseStatus" NOT NULL DEFAULT 'ACTIVE',
  "promiseDate"                   TIMESTAMP(3) NOT NULL,
  "note"                          TEXT,
  "createdAt"                     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdByUserId"               TEXT NOT NULL,
  "resolvedAt"                    TIMESTAMP(3),
  "resolvedByUserId"              TEXT,
  "resolutionNote"                TEXT,
  "sourceInboundCommunicationId"  TEXT,
  "updatedAt"                     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "promise_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "promise"
  ADD CONSTRAINT "promise_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "case"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "promise_caseId_status_idx" ON "promise" ("caseId", "status");

-- Enum extensions for skip reason + timeline events.
ALTER TYPE "ChaseSkippedReason" ADD VALUE IF NOT EXISTS 'PROMISE_ACTIVE';

ALTER TYPE "CaseEventKind" ADD VALUE IF NOT EXISTS 'PROMISE_CREATED';
ALTER TYPE "CaseEventKind" ADD VALUE IF NOT EXISTS 'PROMISE_FULFILLED';
ALTER TYPE "CaseEventKind" ADD VALUE IF NOT EXISTS 'PROMISE_BROKEN';
ALTER TYPE "CaseEventKind" ADD VALUE IF NOT EXISTS 'PROMISE_CANCELLED';
