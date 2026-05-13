# Canonical Data Model

This is the contract. Every integration translates upstream data *into* this model. Every business rule operates *on* this model. Frontend types are generated *from* this model. If a field doesn't exist here, it can't be relied on anywhere else.

The model is defined twice: as a **Prisma schema** (source of truth for the database) and as **Zod schemas** in `shared/canonical/` (source of truth for runtime validation and shared FE/BE types). These two must match. A pre-commit hook verifies field parity.

## Design principles

**Live, not cached.** Money amounts on `Charge` rows are snapshots from the last sync, used for display only. Every rule that depends on a balance re-fetches via `LwcaInvoiceClient.refresh()` before evaluation. The DB schema does not enforce this — the rule layer does — but the field naming reflects it (`lastKnownRemainAmount`, not `remainAmount`).

**Event-sourced timeline.** State changes append to `case_event`. The current row on `case` is a materialised view of the timeline for query convenience. Rules that need "stage at the time of event X" read the timeline, not the current row. Never `UPDATE` an event after insert.

**Money is `BigInt`, in pence.** No floats, no decimals, no currency mixing. LWCA returns pence already; we pass through. Frontend formats at the boundary.

**Dates are `DateTime` in UTC.** Working-day arithmetic and rent-day comparisons convert to Europe/London at the boundary. Storing UTC avoids DST footguns.

**Multi-tenant by `organisationId`.** Every queryable table carries it. Every repository method requires it. There is no global query path.

**Soft delete is rare.** Cases close, they don't delete. Communications are rejected, not deleted. Only `OrganisationConfig` historical versions get archived (and that's via a separate `_history` table, not a `deletedAt` column). Drafts that are auto-rejected by rules (breathing space, etc.) stay on the timeline with reason.

**Natural keys for idempotency.** Upstream references (`lwcaInvoiceId`, `outlookMessageId`) carry unique constraints so re-running polls is safe.

## Entities — overview

| Entity                | Purpose                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `Organisation`        | Tenancy boundary (one row per LWCA `organisationId`)             |
| `OrganisationConfig`  | Per-org rule parameters and templates                            |
| `OrganisationCredential` | Per-org service-user tokens for upstream calls                |
| `Tenancy`             | Mirror of upstream tenancy + denormalised property summary       |
| `Contact`             | Tenant or guarantor, with email/phone                            |
| `TenancyContact`      | Join: contact's role on a tenancy (TENANT / GUARANTOR)           |
| `Case`                | Open arrears episode on a tenancy                                |
| `Charge`              | Mirror of an LWCA invoice; many per case                         |
| `CaseEvent`           | Append-only timeline                                             |
| `ChaseScheduleEntry`  | Per-charge per-stage scheduled events (WD3/WD5/WD8/WD14)         |
| `Communication`       | Drafted or sent message (inbound or outbound)                    |
| `ReviewQueueItem`     | A `Communication` or classification awaiting human approval      |
| `EscalationFlag`      | A live signal on a case (S8 eligible, breathing space, etc.)     |
| `ClassificationResult`| Output of AI classification on an inbound message                |
| `SyncJobRun`          | Audit log of polling executions                                  |

## Prisma schema

```prisma
// backend/src/prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ---------- Organisations ----------

model Organisation {
  id              String   @id                  // matches upstream organisationId (UUID)
  name            String
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  config          OrganisationConfig?
  credential      OrganisationCredential?
  tenancies       Tenancy[]
  cases           Case[]
  contacts        Contact[]
  syncJobRuns     SyncJobRun[]

  @@map("organisation")
}

// Service-user credentials for calling upstream (LWCA + Rentancy) on behalf of this org.
// Entered manually via the configuration page, validated by probe call on save.
// See docs/auth-and-credentials.md for the refresh-token lifecycle.

model OrganisationCredential {
  organisationId           String   @id
  organisation             Organisation @relation(fields: [organisationId], references: [id])

  storageBackend           CredentialStorageBackend

  // For LOCAL backend (POC local dev): AES-256-GCM encrypted blobs.
  accessTokenEncrypted     Bytes?
  refreshTokenEncrypted    Bytes?

  // For SECRETS_MANAGER backend (hosted POC): ARN points to the secret holding both tokens.
  secretArn                String?

  accessTokenExpiresAt     DateTime?
  refreshTokenExpiresAt    DateTime?

  createdByUserId          String
  createdAt                DateTime @default(now())
  rotatedByUserId          String?
  rotatedAt                DateTime?
  lastUsedAt               DateTime?

  @@map("organisation_credential")
}

enum CredentialStorageBackend {
  LOCAL
  SECRETS_MANAGER
}

model OrganisationConfig {
  organisationId  String   @id
  organisation    Organisation @relation(fields: [organisationId], references: [id])

  // Cadence (working days, per charge)
  chaseDayFirst         Int  @default(3)   // WD3
  chaseDaySecond        Int  @default(5)   // WD5
  chaseDayThird         Int  @default(8)   // WD8
  chaseDayExecNotify    Int  @default(14)  // WD14

  // Working-day calendar
  workingDayCalendar    String @default("england-and-wales")  // gov.uk bank-holidays division

  // S8 threshold
  s8RentMonthsThreshold Int  @default(3)
  s8WeeksThreshold      Int  @default(13)

  // Polling
  pollingIntervalMinutes Int @default(15)

  // Auto-send (POC: always false)
  autoSendEnabled        Boolean @default(false)

  // AI
  aiClassificationModel  String  @default("claude-haiku-4-5")
  aiDraftModel           String  @default("claude-sonnet-4-6")
  aiConfidenceThreshold  Decimal @default(0.75) @db.Decimal(3, 2)

  // Templates (Mustache-ish bodies, see docs/business-rules.md)
  templateWd3Tenant      String
  templateWd5Tenant      String
  templateWd8Tenant      String
  templateWd14Tenant     String
  templateBrokenPromise  String

  // Hard-trigger keyword overrides (JSON array, falls back to defaults)
  hardTriggerOverrides   Json?

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@map("organisation_config")
}

// ---------- Tenancy + Contacts ----------

model Tenancy {
  id                  String   @id              // mirrors Rentancy tenancyId (UUID)
  organisationId      String
  organisation        Organisation @relation(fields: [organisationId], references: [id])

  propertyId          String                    // upstream propertyId
  propertyName        String?                   // denormalised for display
  propertyAddress1    String?
  propertyAddress2    String?

  reference           String?                   // human-readable tenancy reference
  rentDayOfMonth      Int?                      // 1-31; from Rentancy.paymentDay
  rentAmountPence     BigInt?                   // current rent per cycle (informational; rules use Charge amounts)

  status              TenancyStatus
  lastSyncedAt        DateTime

  cases               Case[]
  tenancyContacts     TenancyContact[]

  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  @@index([organisationId])
  @@map("tenancy")
}

enum TenancyStatus {
  ACTIVE
  ENDED
  UNKNOWN
}

model Contact {
  id                  String   @id              // mirrors Rentancy contactId (UUID)
  organisationId      String
  organisation        Organisation @relation(fields: [organisationId], references: [id])

  firstName           String?
  lastName            String?
  companyName         String?

  primaryEmail        String?                   // canonical, used for matching inbound mail
  emailsJson          Json                      // full list from Rentancy
  phonesJson          Json
  lastSyncedAt        DateTime

  tenancyContacts     TenancyContact[]

  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  @@unique([organisationId, primaryEmail])
  @@index([organisationId])
  @@map("contact")
}

model TenancyContact {
  tenancyId           String
  contactId           String
  role                ContactRole

  tenancy             Tenancy  @relation(fields: [tenancyId], references: [id])
  contact             Contact  @relation(fields: [contactId], references: [id])

  @@id([tenancyId, contactId, role])
  @@index([tenancyId])
  @@index([contactId])
  @@map("tenancy_contact")
}

enum ContactRole {
  TENANT
  GUARANTOR
}

// ---------- Case + Charges ----------

model Case {
  id                  String   @id @default(uuid())
  organisationId      String
  organisation        Organisation @relation(fields: [organisationId], references: [id])
  tenancyId           String
  tenancy             Tenancy  @relation(fields: [tenancyId], references: [id])

  status              CaseStatus
  openedAt            DateTime
  closedAt            DateTime?

  // Materialised for query convenience; recomputed on every charge sync
  lastKnownBalancePence BigInt   // sum of charge.lastKnownRemainAmountPence
  lastKnownBalanceAt    DateTime

  // Live cache of active escalation flags for fast list-view filtering
  s8Eligible              Boolean @default(false)
  breathingSpaceActive    Boolean @default(false)
  awaitingHandlerAction   Boolean @default(false)

  charges               Charge[]
  events                CaseEvent[]
  chaseScheduleEntries  ChaseScheduleEntry[]
  communications        Communication[]
  escalationFlags       EscalationFlag[]
  classificationResults ClassificationResult[]

  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  // Enforced via raw SQL migration (Prisma doesn't support partial unique indexes):
  //   CREATE UNIQUE INDEX one_active_case_per_tenancy
  //     ON "case" ("tenancyId") WHERE status = 'ACTIVE';

  @@index([organisationId, status])
  @@index([tenancyId, status])
  @@map("case")
}

enum CaseStatus {
  ACTIVE
  CLOSED
}

model Charge {
  id                  String   @id @default(uuid())
  caseId              String
  case                Case     @relation(fields: [caseId], references: [id])
  organisationId      String

  // Upstream linkage — natural key for idempotency
  lwcaInvoiceId       String   @unique

  dueDate             DateTime                     // working-day clock anchors here
  invoiceDate         DateTime
  grossAmountPence    BigInt                       // immutable after first sync
  lastKnownRemainAmountPence BigInt                // updated on every sync
  lastKnownStatus     ChargeStatus
  lastKnownPaymentCycleType String?                // RECURRING etc. — recurring charges excluded from arrears
  lastSyncedAt        DateTime

  // Per-charge cadence state
  currentStage        ChaseStage @default(NOT_DUE)
  currentStageEnteredAt DateTime?
  // working-day count since dueDate, recomputed on each cadence tick (informational)
  workingDaysOverdue  Int        @default(0)

  // Did we step the stage back due to partial-payment rule? (post-MVP)
  stageSteppedBackAt  DateTime?
  stageResetAt        DateTime?

  chaseScheduleEntries ChaseScheduleEntry[]
  communications      Communication[]    @relation("CommunicationCharges")

  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  @@index([caseId])
  @@index([dueDate])
  @@map("charge")
}

enum ChargeStatus {
  UNPAID
  PARTIALLY_PAID
  PARTIALLY_RECONCILED
  PAID
  RECONCILED
  DELETED
  PAYMENT_PROCESSING
}

enum ChaseStage {
  NOT_DUE         // dueDate in future
  AWAITING_WD3
  WD3_SENT
  AWAITING_WD5
  WD5_SENT
  AWAITING_WD8
  WD8_SENT
  AWAITING_WD14
  WD14_NOTIFIED
  RESOLVED        // charge fully paid
}

// ---------- Chase schedule ----------

// One row per scheduled chase event, written when a charge enters arrears.
// The scheduler reads `dueAt`, fires, and marks `firedAt`. Per-charge cadence;
// daily-digest delivery consolidates multiple `firedAt` events into one Communication.

model ChaseScheduleEntry {
  id                  String   @id @default(uuid())
  caseId              String
  case                Case     @relation(fields: [caseId], references: [id])
  chargeId            String
  charge              Charge   @relation(fields: [chargeId], references: [id])

  stage               ChaseStage           // WD3_SENT / WD5_SENT / WD8_SENT / WD14_NOTIFIED
  dueAt               DateTime             // computed in UTC from dueDate + working-day offset, anchored at 09:00 Europe/London
  firedAt             DateTime?
  skippedReason       ChaseSkippedReason?  // when fired-but-not-acted (e.g. breathing space, already resolved)

  createdAt           DateTime @default(now())

  @@unique([chargeId, stage])               // idempotency: re-running scheduler can't double-create
  @@index([dueAt, firedAt])
  @@map("chase_schedule_entry")
}

enum ChaseSkippedReason {
  BREATHING_SPACE_ACTIVE
  CHARGE_RESOLVED
  CASE_CLOSED
  AUTOSEND_DISABLED_AND_DRAFT_REJECTED
}

// ---------- Timeline ----------

model CaseEvent {
  id                  String   @id @default(uuid())
  caseId              String
  case                Case     @relation(fields: [caseId], references: [id])

  kind                CaseEventKind
  payloadJson         Json
  actorUserId         String?  // null for system events; UUID for human actions
  occurredAt          DateTime @default(now())

  @@index([caseId, occurredAt])
  @@map("case_event")
}

enum CaseEventKind {
  CASE_OPENED
  CASE_CLOSED
  CHARGE_ADDED
  CHARGE_SYNCED
  CHARGE_FULLY_PAID
  CHARGE_PARTIALLY_PAID
  CHASE_STAGE_ADVANCED
  CHASE_EVENT_FIRED
  COMMUNICATION_DRAFTED
  COMMUNICATION_APPROVED
  COMMUNICATION_REJECTED
  COMMUNICATION_SENT
  COMMUNICATION_RECEIVED
  CLASSIFICATION_PRODUCED
  HARD_TRIGGER_MATCHED
  ESCALATION_FLAG_RAISED
  ESCALATION_FLAG_CLEARED
  BREATHING_SPACE_ACTIVATED
  BREATHING_SPACE_DEACTIVATED
  S8_ELIGIBILITY_RAISED
  S8_ELIGIBILITY_RESCINDED
  HANDLER_ASSIGNED
}

// ---------- Communications ----------

// One row per inbound or outbound message.
// Outbound communications often relate to multiple charges (daily digest);
// the join is via CommunicationCharges.

model Communication {
  id                  String   @id @default(uuid())
  caseId              String
  case                Case     @relation(fields: [caseId], references: [id])
  organisationId      String

  direction           CommunicationDirection
  channel             CommunicationChannel
  status              CommunicationStatus

  // For outbound:
  toAddress           String?
  recipientRole       RecipientRole?         // TENANT or GUARANTOR
  subject             String?
  bodyMarkdown        String?
  bodyHtml            String?
  consolidatedStage   ChaseStage?            // most-severe stage chosen for this digest
  draftedByAi         Boolean   @default(false)

  // For inbound:
  fromAddress         String?
  receivedAt          DateTime?
  outlookMessageId    String?   @unique
  rawBodyText         String?

  // Approval flow
  reviewQueueItem     ReviewQueueItem?
  approvedByUserId    String?
  approvedAt          DateTime?
  rejectedByUserId    String?
  rejectedAt          DateTime?
  rejectionReason     String?

  // Send result
  sentAt              DateTime?
  outlookSentMessageId String?
  sendErrorJson       Json?

  charges             Charge[] @relation("CommunicationCharges")

  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  @@index([caseId, direction, status])
  @@index([organisationId])
  @@map("communication")
}

enum CommunicationDirection {
  INBOUND
  OUTBOUND
}

enum CommunicationChannel {
  EMAIL
  WHATSAPP   // reserved, not built in POC
}

enum CommunicationStatus {
  DRAFTED
  AWAITING_APPROVAL
  APPROVED
  SENT
  SEND_FAILED
  REJECTED
  AUTO_REJECTED
  RECEIVED
  PROCESSED
}

enum RecipientRole {
  TENANT
  GUARANTOR
}

// ---------- Review queue ----------

// A unified queue of items needing human action: outbound drafts pending approval,
// inbound classifications below confidence threshold, hard-trigger escalations.

model ReviewQueueItem {
  id                  String   @id @default(uuid())
  organisationId      String
  caseId              String
  kind                ReviewItemKind

  // Discriminated link (one of):
  communicationId     String?   @unique
  communication       Communication? @relation(fields: [communicationId], references: [id])
  classificationResultId String? @unique

  priority            ReviewItemPriority
  resolvedAt          DateTime?
  resolvedByUserId    String?
  resolution          ReviewItemResolution?

  createdAt           DateTime @default(now())

  @@index([organisationId, resolvedAt, priority])
  @@map("review_queue_item")
}

enum ReviewItemKind {
  OUTBOUND_DRAFT_APPROVAL
  INBOUND_LOW_CONFIDENCE
  HARD_TRIGGER_ESCALATION
}

enum ReviewItemPriority {
  LOW
  NORMAL
  HIGH
  URGENT   // hard-trigger escalations land here
}

enum ReviewItemResolution {
  APPROVED_AND_SENT
  EDITED_AND_SENT
  REJECTED
  HANDLER_ACTIONED
  DISMISSED
}

// ---------- Escalation flags ----------

// Live signals on a case. A flag is "raised" (no resolvedAt) until conditions clear.
// Flags drive both UI and rule decisions.

model EscalationFlag {
  id                  String   @id @default(uuid())
  caseId              String
  case                Case     @relation(fields: [caseId], references: [id])
  kind                EscalationFlagKind
  payloadJson         Json?

  raisedAt            DateTime @default(now())
  raisedReason        String
  resolvedAt          DateTime?
  resolvedReason      String?

  @@index([caseId, kind, resolvedAt])
  @@map("escalation_flag")
}

enum EscalationFlagKind {
  S8_ELIGIBLE
  BREATHING_SPACE
  HARDSHIP_INDICATED
  MENTAL_HEALTH_INDICATED
  THIRD_PARTY_INVOLVED
  LIABILITY_DISPUTED
  DOMESTIC_CIRCUMSTANCES
  AI_CONFIDENCE_FAILURE
  STALE_BALANCE_60D       // post-MVP rule
  REPEATED_SMALL_PAYMENTS // post-MVP rule
}

// ---------- AI classifications ----------

model ClassificationResult {
  id                  String   @id @default(uuid())
  caseId              String
  case                Case     @relation(fields: [caseId], references: [id])
  communicationId     String   @unique          // the inbound message classified

  // Deterministic pre-filter outcome (always populated)
  preFilterMatched    Boolean
  preFilterTriggerKind EscalationFlagKind?
  preFilterMatchedKeyword String?

  // LLM outcome (null if pre-filter matched — LLM never invoked)
  modelUsed           String?
  sentiment           Sentiment?
  intent              InboundIntent?
  confidence          Decimal? @db.Decimal(3, 2)
  rationale           String?    // short text reason from the model
  promptTokens        Int?
  completionTokens    Int?
  estimatedCostPence  Int?

  createdAt           DateTime @default(now())

  @@map("classification_result")
}

enum Sentiment {
  POSITIVE
  NEUTRAL
  NEGATIVE
  DISTRESSED
}

enum InboundIntent {
  PAYMENT_PROMISE
  PAYMENT_CONFIRMATION
  QUERY
  COMPLAINT
  REQUEST_FOR_INFO
  UNCLEAR
}

// ---------- Sync job audit ----------

model SyncJobRun {
  id                  String   @id @default(uuid())
  organisationId      String
  organisation        Organisation @relation(fields: [organisationId], references: [id])
  kind                SyncJobKind
  startedAt           DateTime @default(now())
  finishedAt          DateTime?
  status              SyncJobStatus @default(RUNNING)
  itemsProcessed      Int @default(0)
  itemsCreated        Int @default(0)
  itemsUpdated        Int @default(0)
  errorJson           Json?

  @@index([organisationId, kind, startedAt])
  @@map("sync_job_run")
}

enum SyncJobKind {
  LWCA_INVOICE_POLL
  RENTANCY_TENANCY_REFRESH
  RENTANCY_CONTACT_REFRESH
  OUTLOOK_INBOUND_POLL
  CHASE_TICK
}

enum SyncJobStatus {
  RUNNING
  COMPLETED
  FAILED
}
```

### Raw SQL migrations

Two things Prisma cannot express, applied via raw migration after `prisma migrate`:

```sql
-- One active case per tenancy
CREATE UNIQUE INDEX one_active_case_per_tenancy
  ON "case" ("tenancyId")
  WHERE status = 'ACTIVE';

-- Working-day overdue is recomputed; index supports the cadence tick scan
CREATE INDEX charge_overdue_scan
  ON charge ("lastKnownStatus", "dueDate")
  WHERE "lastKnownStatus" IN ('UNPAID', 'PARTIALLY_PAID', 'PARTIALLY_RECONCILED');
```

## Zod schemas — `shared/canonical/`

Co-located with the Prisma model and kept in lockstep. Excerpts shown; full schemas in the repo.

```ts
// shared/canonical/src/case.ts
import { z } from 'zod';

export const PenceSchema = z.bigint().nonnegative();
export const OrgScopedIdSchema = z.string().uuid();

export const ChaseStageSchema = z.enum([
  'NOT_DUE',
  'AWAITING_WD3', 'WD3_SENT',
  'AWAITING_WD5', 'WD5_SENT',
  'AWAITING_WD8', 'WD8_SENT',
  'AWAITING_WD14', 'WD14_NOTIFIED',
  'RESOLVED',
]);
export type ChaseStage = z.infer<typeof ChaseStageSchema>;

export const ChargeSchema = z.object({
  id: z.string().uuid(),
  caseId: z.string().uuid(),
  organisationId: z.string(),
  lwcaInvoiceId: z.string(),
  dueDate: z.coerce.date(),
  invoiceDate: z.coerce.date(),
  grossAmountPence: PenceSchema,
  lastKnownRemainAmountPence: PenceSchema,
  lastKnownStatus: z.enum([
    'UNPAID', 'PARTIALLY_PAID', 'PARTIALLY_RECONCILED',
    'PAID', 'RECONCILED', 'DELETED', 'PAYMENT_PROCESSING',
  ]),
  currentStage: ChaseStageSchema,
  currentStageEnteredAt: z.coerce.date().nullable(),
  workingDaysOverdue: z.number().int().nonnegative(),
  lastSyncedAt: z.coerce.date(),
});
export type Charge = z.infer<typeof ChargeSchema>;

export const CaseSchema = z.object({
  id: z.string().uuid(),
  organisationId: z.string(),
  tenancyId: z.string(),
  status: z.enum(['ACTIVE', 'CLOSED']),
  openedAt: z.coerce.date(),
  closedAt: z.coerce.date().nullable(),
  lastKnownBalancePence: PenceSchema,
  lastKnownBalanceAt: z.coerce.date(),
  s8Eligible: z.boolean(),
  breathingSpaceActive: z.boolean(),
  awaitingHandlerAction: z.boolean(),
});
export type Case = z.infer<typeof CaseSchema>;
```

Parity script (`shared/canonical/scripts/check-parity.ts`) reflects Prisma's generated client types against Zod schemas at build time. Field name or type drift fails the build.

## Field-level rationale — the non-obvious choices

**Why `lastKnownRemainAmountPence`, not `remainAmountPence`?** Naming reinforces that this field is a snapshot, not a source of truth. Any rule reading it must first re-sync via `LwcaInvoiceClient.refresh()`. Code reviewers flag any rule that consumes `lastKnown*` without a refresh.

**Why a separate `currentStage` on `Charge` rather than deriving it from `ChaseScheduleEntry`?** Reads dominate writes. The case list view in the UI shows current stage per charge; deriving it from the schedule on every load is wasteful. The materialised column is updated transactionally with the schedule entry that promoted it, and the timeline is the audit trail.

**Why `consolidatedStage` on `Communication`?** Per the "most-severe-tone wins" rule. The daily digest job picks the most severe stage among the charges firing on that day, records it on the communication, and the template renderer uses it to pick the right tone variant. Reviewers can see at a glance which tone was selected.

**Why no `dueDate` index without `lastKnownStatus` qualifier?** The cadence tick only scans charges in arrears statuses. A naive `dueDate` index would bloat with `PAID` and `RECONCILED` rows. The partial index above keeps the working set small.

**Why is `ClassificationResult` 1:1 with the inbound `Communication` instead of embedded?** Pre-filter outcome is data — `preFilterMatched`, the matched keyword, the trigger kind. Re-evaluating triggers (e.g. tuning the keyword list) needs a place to record before/after. Separate table makes that history queryable.

**Why both `EscalationFlag` and the booleans on `Case`?** The booleans are denormalised for fast list-view filtering ("show me all S8-eligible cases"). The `EscalationFlag` table is the audit trail (when raised, why, when cleared). They are kept in sync by a single service method (`escalationService.raise()` / `.clear()`), never written independently.

**Why `Contact.primaryEmail` unique within org?** Inbound mail matching: when a message arrives from `tenant@example.com`, we look up `Contact` by `(organisationId, primaryEmail)`. Without a unique constraint, ambiguous matches would silently pick the first row.

**Why `outlookMessageId` unique globally, not scoped?** Graph message IDs are globally unique. Idempotency on inbound poll: re-running the poller can't double-ingest. Without the unique, a flaky poll retry produces duplicate timeline events.

## Materialisation invariants

Code in `backend/src/modules/cases/case.service.ts` must keep these consistent — verified by integration tests in `__tests__/invariants/`:

1. `case.lastKnownBalancePence` = sum of `charge.lastKnownRemainAmountPence` for all charges on the case, computed after each charge sync.
2. `case.status = 'CLOSED'` iff every charge has status in `(PAID, RECONCILED, DELETED)` AND `lastKnownBalancePence = 0`.
3. `case.s8Eligible = true` iff `lastKnownBalancePence ≥ s8Threshold(orgConfig, tenancy)` AND `breathingSpaceActive = false`.
4. Exactly one `Case` per `tenancyId` has `status = 'ACTIVE'` at any time (enforced by partial unique index above; rule transactions must respect it).
5. Every `ChaseScheduleEntry.firedAt IS NOT NULL` has a corresponding `CaseEvent` with `kind = 'CHASE_EVENT_FIRED'`.
6. Every `Communication` with `direction = 'OUTBOUND'` and `status IN ('AWAITING_APPROVAL', 'APPROVED', 'SENT')` has a corresponding `ReviewQueueItem` (resolved or pending).

## Seed data

`backend/prisma/seed.ts` provisions for local dev:

- One `Organisation` matching the LWCA stage demo organisation ID (env: `DEMO_ORG_ID`)
- Default `OrganisationConfig` (TLP BRD values)
- No tenancies / cases / charges — those flow from the first poll

## Migrations approach

- New field on canonical model → Prisma migration + Zod schema update + mapper update in every integration client + parity check passes → land in same PR.
- Rule changes that don't alter the schema → no migration needed; rules live in code.
- Schema changes that affect timeline interpretation → migration plus a `case_event` `schemaVersion` bump on new events. Old events retain their original payload shape; readers handle both.

## What's deliberately not in this model

- **No `Promise` entity yet.** Payment promises are deferred to a post-MVP slice. When added, they'll be modelled as their own entity with a state machine, not as fields on `Case`.
- **No guarantor parallel cadence state.** Guarantor data flows via `TenancyContact` with `role = GUARANTOR`, but the parallel cadence (separate `ChaseScheduleEntry` per guarantor per charge) is post-MVP. When added: same table, with a new `recipientRole` column on `ChaseScheduleEntry`.
- **No partial-payment stage-step-back history.** The `Charge.stageSteppedBackAt` and `stageResetAt` columns are stubbed for forward-compatibility but unused in MVP.
- **No multi-currency.** GBP only. If non-GBP organisations appear, add `currency` to `Charge` and rule definitions, not as a global flag.
- **No tenant-facing identity.** Tenants never log in; they receive emails and reply. No account state for them in this system.

## Open items

- Index strategy on `case_event` will likely need partitioning by `occurredAt` if/when timeline volume grows. POC scale: not yet.
- `OrganisationConfig.templateWd*` storage — Markdown templates live in DB rows for POC. May move to S3 or a `Template` table if templates grow per-organisation. Not decided.
- Whether `Tenancy.rentDayOfMonth` should ever drive rule logic, or remain informational only. POC: informational only; rules operate on Charge.dueDate (the actual invoice due date), which already reflects rent day at the time of invoice creation.
