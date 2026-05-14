-- CreateEnum
CREATE TYPE "CredentialStorageBackend" AS ENUM ('LOCAL', 'SECRETS_MANAGER');

-- CreateEnum
CREATE TYPE "TenancyStatus" AS ENUM ('ACTIVE', 'ENDED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ContactRole" AS ENUM ('TENANT', 'GUARANTOR');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "ChargeStatus" AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PARTIALLY_RECONCILED', 'PAID', 'RECONCILED', 'DELETED', 'PAYMENT_PROCESSING');

-- CreateEnum
CREATE TYPE "ChaseStage" AS ENUM ('NOT_DUE', 'AWAITING_WD3', 'WD3_SENT', 'AWAITING_WD5', 'WD5_SENT', 'AWAITING_WD8', 'WD8_SENT', 'AWAITING_WD14', 'WD14_NOTIFIED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ChaseSkippedReason" AS ENUM ('BREATHING_SPACE_ACTIVE', 'CHARGE_RESOLVED', 'CASE_CLOSED', 'AUTOSEND_DISABLED_AND_DRAFT_REJECTED');

-- CreateEnum
CREATE TYPE "CaseEventKind" AS ENUM ('CASE_OPENED', 'CASE_CLOSED', 'CHARGE_ADDED', 'CHARGE_SYNCED', 'CHARGE_FULLY_PAID', 'CHARGE_PARTIALLY_PAID', 'CHASE_STAGE_ADVANCED', 'CHASE_EVENT_FIRED', 'COMMUNICATION_DRAFTED', 'COMMUNICATION_APPROVED', 'COMMUNICATION_REJECTED', 'COMMUNICATION_SENT', 'COMMUNICATION_RECEIVED', 'CLASSIFICATION_PRODUCED', 'HARD_TRIGGER_MATCHED', 'ESCALATION_FLAG_RAISED', 'ESCALATION_FLAG_CLEARED', 'BREATHING_SPACE_ACTIVATED', 'BREATHING_SPACE_DEACTIVATED', 'S8_ELIGIBILITY_RAISED', 'S8_ELIGIBILITY_RESCINDED', 'HANDLER_ASSIGNED');

-- CreateEnum
CREATE TYPE "CommunicationDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "CommunicationChannel" AS ENUM ('EMAIL', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "CommunicationStatus" AS ENUM ('DRAFTED', 'AWAITING_APPROVAL', 'APPROVED', 'SENT', 'SEND_FAILED', 'REJECTED', 'AUTO_REJECTED', 'RECEIVED', 'PROCESSED');

-- CreateEnum
CREATE TYPE "RecipientRole" AS ENUM ('TENANT', 'GUARANTOR');

-- CreateEnum
CREATE TYPE "ReviewItemKind" AS ENUM ('OUTBOUND_DRAFT_APPROVAL', 'INBOUND_LOW_CONFIDENCE', 'HARD_TRIGGER_ESCALATION');

-- CreateEnum
CREATE TYPE "ReviewItemPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ReviewItemResolution" AS ENUM ('APPROVED_AND_SENT', 'EDITED_AND_SENT', 'REJECTED', 'HANDLER_ACTIONED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "EscalationFlagKind" AS ENUM ('S8_ELIGIBLE', 'BREATHING_SPACE', 'HARDSHIP_INDICATED', 'MENTAL_HEALTH_INDICATED', 'THIRD_PARTY_INVOLVED', 'LIABILITY_DISPUTED', 'DOMESTIC_CIRCUMSTANCES', 'AI_CONFIDENCE_FAILURE', 'STALE_BALANCE_60D', 'REPEATED_SMALL_PAYMENTS');

-- CreateEnum
CREATE TYPE "Sentiment" AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE', 'DISTRESSED');

-- CreateEnum
CREATE TYPE "InboundIntent" AS ENUM ('PAYMENT_PROMISE', 'PAYMENT_CONFIRMATION', 'QUERY', 'COMPLAINT', 'REQUEST_FOR_INFO', 'UNCLEAR');

-- CreateEnum
CREATE TYPE "SyncJobKind" AS ENUM ('LWCA_INVOICE_POLL', 'RENTANCY_TENANCY_REFRESH', 'RENTANCY_CONTACT_REFRESH', 'OUTLOOK_INBOUND_POLL', 'CHASE_TICK');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "organisation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organisation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisation_credential" (
    "organisationId" TEXT NOT NULL,
    "storageBackend" "CredentialStorageBackend" NOT NULL,
    "accessTokenEncrypted" BYTEA,
    "refreshTokenEncrypted" BYTEA,
    "secretArn" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedByUserId" TEXT,
    "rotatedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "organisation_credential_pkey" PRIMARY KEY ("organisationId")
);

-- CreateTable
CREATE TABLE "organisation_config" (
    "organisationId" TEXT NOT NULL,
    "chaseDayFirst" INTEGER NOT NULL DEFAULT 3,
    "chaseDaySecond" INTEGER NOT NULL DEFAULT 5,
    "chaseDayThird" INTEGER NOT NULL DEFAULT 8,
    "chaseDayExecNotify" INTEGER NOT NULL DEFAULT 14,
    "workingDayCalendar" TEXT NOT NULL DEFAULT 'england-and-wales',
    "s8RentMonthsThreshold" INTEGER NOT NULL DEFAULT 3,
    "s8WeeksThreshold" INTEGER NOT NULL DEFAULT 13,
    "pollingIntervalMinutes" INTEGER NOT NULL DEFAULT 15,
    "autoSendEnabled" BOOLEAN NOT NULL DEFAULT false,
    "aiClassificationModel" TEXT NOT NULL DEFAULT 'claude-haiku-4-5',
    "aiDraftModel" TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    "aiConfidenceThreshold" DECIMAL(3,2) NOT NULL DEFAULT 0.75,
    "templateWd3Tenant" TEXT NOT NULL,
    "templateWd5Tenant" TEXT NOT NULL,
    "templateWd8Tenant" TEXT NOT NULL,
    "templateWd14Tenant" TEXT NOT NULL,
    "templateBrokenPromise" TEXT NOT NULL,
    "hardTriggerOverrides" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organisation_config_pkey" PRIMARY KEY ("organisationId")
);

-- CreateTable
CREATE TABLE "tenancy" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "propertyName" TEXT,
    "propertyAddress1" TEXT,
    "propertyAddress2" TEXT,
    "reference" TEXT,
    "rentDayOfMonth" INTEGER,
    "rentAmountPence" BIGINT,
    "status" "TenancyStatus" NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenancy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "companyName" TEXT,
    "primaryEmail" TEXT,
    "emailsJson" JSONB NOT NULL,
    "phonesJson" JSONB NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenancy_contact" (
    "tenancyId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "role" "ContactRole" NOT NULL,

    CONSTRAINT "tenancy_contact_pkey" PRIMARY KEY ("tenancyId","contactId","role")
);

-- CreateTable
CREATE TABLE "case" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "tenancyId" TEXT NOT NULL,
    "status" "CaseStatus" NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "lastKnownBalancePence" BIGINT NOT NULL,
    "lastKnownBalanceAt" TIMESTAMP(3) NOT NULL,
    "s8Eligible" BOOLEAN NOT NULL DEFAULT false,
    "breathingSpaceActive" BOOLEAN NOT NULL DEFAULT false,
    "awaitingHandlerAction" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charge" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "lwcaInvoiceId" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "invoiceDate" TIMESTAMP(3) NOT NULL,
    "grossAmountPence" BIGINT NOT NULL,
    "lastKnownRemainAmountPence" BIGINT NOT NULL,
    "lastKnownStatus" "ChargeStatus" NOT NULL,
    "lastKnownPaymentCycleType" TEXT,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "currentStage" "ChaseStage" NOT NULL DEFAULT 'NOT_DUE',
    "currentStageEnteredAt" TIMESTAMP(3),
    "workingDaysOverdue" INTEGER NOT NULL DEFAULT 0,
    "stageSteppedBackAt" TIMESTAMP(3),
    "stageResetAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "charge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chase_schedule_entry" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "stage" "ChaseStage" NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "firedAt" TIMESTAMP(3),
    "skippedReason" "ChaseSkippedReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chase_schedule_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_event" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "kind" "CaseEventKind" NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "actorUserId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "direction" "CommunicationDirection" NOT NULL,
    "channel" "CommunicationChannel" NOT NULL,
    "status" "CommunicationStatus" NOT NULL,
    "toAddress" TEXT,
    "recipientRole" "RecipientRole",
    "subject" TEXT,
    "bodyMarkdown" TEXT,
    "bodyHtml" TEXT,
    "consolidatedStage" "ChaseStage",
    "draftedByAi" BOOLEAN NOT NULL DEFAULT false,
    "fromAddress" TEXT,
    "receivedAt" TIMESTAMP(3),
    "outlookMessageId" TEXT,
    "rawBodyText" TEXT,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedByUserId" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "sentAt" TIMESTAMP(3),
    "outlookSentMessageId" TEXT,
    "sendErrorJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "communication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_queue_item" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "kind" "ReviewItemKind" NOT NULL,
    "communicationId" TEXT,
    "classificationResultId" TEXT,
    "priority" "ReviewItemPriority" NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "resolution" "ReviewItemResolution",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_queue_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escalation_flag" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "kind" "EscalationFlagKind" NOT NULL,
    "payloadJson" JSONB,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raisedReason" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedReason" TEXT,

    CONSTRAINT "escalation_flag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classification_result" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "communicationId" TEXT NOT NULL,
    "preFilterMatched" BOOLEAN NOT NULL,
    "preFilterTriggerKind" "EscalationFlagKind",
    "preFilterMatchedKeyword" TEXT,
    "modelUsed" TEXT,
    "sentiment" "Sentiment",
    "intent" "InboundIntent",
    "confidence" DECIMAL(3,2),
    "rationale" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "estimatedCostPence" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "classification_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_job_run" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "kind" "SyncJobKind" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" "SyncJobStatus" NOT NULL DEFAULT 'RUNNING',
    "itemsProcessed" INTEGER NOT NULL DEFAULT 0,
    "itemsCreated" INTEGER NOT NULL DEFAULT 0,
    "itemsUpdated" INTEGER NOT NULL DEFAULT 0,
    "errorJson" JSONB,

    CONSTRAINT "sync_job_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_CommunicationCharges" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "tenancy_organisationId_idx" ON "tenancy"("organisationId");

-- CreateIndex
CREATE INDEX "contact_organisationId_idx" ON "contact"("organisationId");

-- CreateIndex
CREATE UNIQUE INDEX "contact_organisationId_primaryEmail_key" ON "contact"("organisationId", "primaryEmail");

-- CreateIndex
CREATE INDEX "tenancy_contact_tenancyId_idx" ON "tenancy_contact"("tenancyId");

-- CreateIndex
CREATE INDEX "tenancy_contact_contactId_idx" ON "tenancy_contact"("contactId");

-- CreateIndex
CREATE INDEX "case_organisationId_status_idx" ON "case"("organisationId", "status");

-- CreateIndex
CREATE INDEX "case_tenancyId_status_idx" ON "case"("tenancyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "charge_lwcaInvoiceId_key" ON "charge"("lwcaInvoiceId");

-- CreateIndex
CREATE INDEX "charge_caseId_idx" ON "charge"("caseId");

-- CreateIndex
CREATE INDEX "charge_dueDate_idx" ON "charge"("dueDate");

-- CreateIndex
CREATE INDEX "chase_schedule_entry_dueAt_firedAt_idx" ON "chase_schedule_entry"("dueAt", "firedAt");

-- CreateIndex
CREATE UNIQUE INDEX "chase_schedule_entry_chargeId_stage_key" ON "chase_schedule_entry"("chargeId", "stage");

-- CreateIndex
CREATE INDEX "case_event_caseId_occurredAt_idx" ON "case_event"("caseId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "communication_outlookMessageId_key" ON "communication"("outlookMessageId");

-- CreateIndex
CREATE INDEX "communication_caseId_direction_status_idx" ON "communication"("caseId", "direction", "status");

-- CreateIndex
CREATE INDEX "communication_organisationId_idx" ON "communication"("organisationId");

-- CreateIndex
CREATE UNIQUE INDEX "review_queue_item_communicationId_key" ON "review_queue_item"("communicationId");

-- CreateIndex
CREATE UNIQUE INDEX "review_queue_item_classificationResultId_key" ON "review_queue_item"("classificationResultId");

-- CreateIndex
CREATE INDEX "review_queue_item_organisationId_resolvedAt_priority_idx" ON "review_queue_item"("organisationId", "resolvedAt", "priority");

-- CreateIndex
CREATE INDEX "escalation_flag_caseId_kind_resolvedAt_idx" ON "escalation_flag"("caseId", "kind", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "classification_result_communicationId_key" ON "classification_result"("communicationId");

-- CreateIndex
CREATE INDEX "sync_job_run_organisationId_kind_startedAt_idx" ON "sync_job_run"("organisationId", "kind", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "_CommunicationCharges_AB_unique" ON "_CommunicationCharges"("A", "B");

-- CreateIndex
CREATE INDEX "_CommunicationCharges_B_index" ON "_CommunicationCharges"("B");

-- AddForeignKey
ALTER TABLE "organisation_credential" ADD CONSTRAINT "organisation_credential_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_config" ADD CONSTRAINT "organisation_config_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenancy" ADD CONSTRAINT "tenancy_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact" ADD CONSTRAINT "contact_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenancy_contact" ADD CONSTRAINT "tenancy_contact_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "tenancy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenancy_contact" ADD CONSTRAINT "tenancy_contact_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case" ADD CONSTRAINT "case_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case" ADD CONSTRAINT "case_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "tenancy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge" ADD CONSTRAINT "charge_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chase_schedule_entry" ADD CONSTRAINT "chase_schedule_entry_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chase_schedule_entry" ADD CONSTRAINT "chase_schedule_entry_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "charge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_event" ADD CONSTRAINT "case_event_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication" ADD CONSTRAINT "communication_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_queue_item" ADD CONSTRAINT "review_queue_item_communicationId_fkey" FOREIGN KEY ("communicationId") REFERENCES "communication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalation_flag" ADD CONSTRAINT "escalation_flag_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classification_result" ADD CONSTRAINT "classification_result_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_job_run" ADD CONSTRAINT "sync_job_run_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CommunicationCharges" ADD CONSTRAINT "_CommunicationCharges_A_fkey" FOREIGN KEY ("A") REFERENCES "charge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CommunicationCharges" ADD CONSTRAINT "_CommunicationCharges_B_fkey" FOREIGN KEY ("B") REFERENCES "communication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
