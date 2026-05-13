# Architecture

How the parts fit together. Component responsibilities, message flow, deployment topology for local and hosted POC.

This doc explains *what runs where* and *how data moves*. For the entities themselves, see `docs/canonical-data-model.md`. For per-integration detail, see `docs/integrations/*`. For rule definitions, see `docs/business-rules.md`.

## Architectural goals

The shape exists to satisfy four constraints, in order:

1. **Platform-agnostic.** Upstream systems are interchangeable. The Arrears core never reaches past the canonical model into upstream-specific types or APIs.
2. **Live balance, never trusted cache.** Every rule reads the upstream balance through a single client at decision time. Snapshots in DB are for display, not decisions.
3. **Auditable.** Every state change leaves a timeline event. Every outbound message has a review history. Every rule decision can be replayed.
4. **Safe by default.** Outbound to tenants is gated through human approval. Hard-trigger detection runs before LLM. No autonomous escalation of legal posture.

## Component map

```
┌────────────────────────────────────────────────────────────────────────────┐
│                              Arrears Service                                │
│                                                                            │
│  ┌──────────────────────┐         ┌───────────────────────┐                │
│  │  Web (React/Vite)    │  HTTPS  │  API (NestJS)         │                │
│  │  - Cases list        │ ───────▶│  - REST controllers    │                │
│  │  - Case detail       │ ◀────── │  - Auth (JWT)          │                │
│  │  - Review queue      │         │  - Service modules     │                │
│  │  - Config            │         │  - Repositories        │                │
│  └──────────────────────┘         │  - Integration clients │                │
│                                   │  - Scheduler (cron)    │                │
│                                   └─────────┬─────────────┘                │
│                                             │                              │
│                                   ┌─────────▼──────────┐                   │
│                                   │  PostgreSQL         │                   │
│                                   │  (Prisma)           │                   │
│                                   └────────────────────┘                   │
└────────────────────────────────────────────────────────────────────────────┘
                                             │
                ┌────────────────────────────┼─────────────────────────────┐
                │                            │                             │
                ▼                            ▼                             ▼
        ┌──────────────┐           ┌────────────────┐            ┌─────────────────┐
        │ LWCA stage   │           │ Rentancy API   │            │ Outlook         │
        │ (Accounting) │           │  stage         │            │ (MS Graph)      │
        │ Spring Boot  │           │  Lambda+DDB    │            │ Shared mailbox  │
        │ Invoice API  │           │  Tenancy +     │            │                 │
        │              │           │  Contact APIs  │            │                 │
        └──────────────┘           └────────────────┘            └─────────────────┘

                                             │
                                             ▼
                                   ┌────────────────────┐
                                   │ Anthropic API      │
                                   │ Haiku (classify)   │
                                   │ Sonnet (draft)     │
                                   └────────────────────┘
```

For POC, the API and the scheduler run **in the same NestJS process**. The "worker" is a `@nestjs/schedule` cron module loaded by the same bootstrap. Extracting it to a separate process is a hosted-POC scaling exercise, not a Phase-1 requirement.

## Module map (backend)

NestJS modules under `backend/src/modules/`. Each has the standard `<name>.module.ts`, controller, service, repository, DTOs, and `__tests__/`.

| Module             | Responsibility                                                                    |
| ------------------ | --------------------------------------------------------------------------------- |
| `organisations`    | Org list, create, validate-and-store credentials, probe upstream                  |
| `cases`            | Case lifecycle: open, close, list, detail, recompute balance                      |
| `charges`          | Per-charge state, stage advancement, charge sync against LWCA                     |
| `chase`            | Chase schedule + cadence tick + daily digest generator                            |
| `communications`   | Inbound + outbound message records, send execution                                |
| `review-queue`     | Queue listing, approve, edit, reject, dispatch on approval                        |
| `ai`               | Anthropic client wrapper, pre-filter, classification, drafting                    |
| `inbound`          | Outlook polling + matching to case + routing to pre-filter then AI                |
| `escalation`       | Flag raise/clear, S8 threshold check, breathing-space toggle                      |
| `config`           | Per-organisation configuration CRUD                                               |
| `auth`             | JWT verification for Arrears users; service-token rotation for upstream calls     |
| `working-day`      | Calendar source, working-day arithmetic (the only place that knows about WDs)     |

Integration clients (`backend/src/integrations/`) sit outside the module tree and are injected into the modules that need them:

| Client                  | Responsibility                                                              |
| ----------------------- | --------------------------------------------------------------------------- |
| `LwcaInvoiceClient`     | List arrears invoices, refresh one invoice — uses per-org credential store  |
| `RentancyTenancyClient` | Get tenancy, get contact — uses per-org credential store                    |
| `OutlookGraphClient`    | Poll inbound, send outbound — single mailbox, app-level credentials         |
| `AnthropicClient`       | Wraps `@anthropic-ai/sdk`, model selection, cost logging                    |
| `CredentialStore`       | Encrypted access/refresh tokens per org; pluggable backend                  |
| `WorkingDayCalendar`    | gov.uk bank-holidays JSON, cached daily                                     |

Every integration client implements a thin interface and ships with a `Fixture*` companion that returns canned fixtures. `INTEGRATION_MODE=fixtures` swaps the real client for the fixture one for tests and offline dev.

## Frontend structure

React + Vite + shadcn/ui, TanStack Query for server state, React Router for navigation.

```
frontend/src/
├── pages/
│   ├── Login.tsx
│   ├── CasesList.tsx              filter, sort, pagination
│   ├── CaseDetail.tsx             header + timeline + charges + communications
│   ├── ReviewQueue.tsx            single list of items awaiting action
│   ├── OrganisationsList.tsx      configured orgs
│   ├── OrganisationConfig.tsx     per-org config form including credentials
│   └── DevTools.tsx               advance-clock + force-sync (dev-only)
├── components/
│   ├── case/                      CaseHeader, ChargeRow, EventTimeline, Communications
│   ├── review/                    DraftPreview, EditDraft, RejectReasonDialog
│   ├── config/                    CadenceConfigForm, TemplatesEditor, CredentialsCard
│   └── ui/                        shadcn primitives
├── lib/
│   ├── api/                       generated OpenAPI client
│   ├── auth.tsx                   useAuth, AuthProvider
│   ├── format.ts                  currency, dates, working days
│   └── canonical.ts               re-exports from shared/canonical
└── App.tsx
```

API client generated from backend OpenAPI on every `pnpm dev` start. No hand-written DTOs in the frontend.

## Authentication and authorisation

Two distinct auth surfaces, deliberately separate.

**Arrears users (humans).** Arrears-owned Cognito user pool. Internal staff invited manually. JWT bearer in `Authorization` headers. NestJS `AuthGuard` extracts `userId` and `email`. Roles come later; POC has a single role (`ARREARS_STAFF`). Local dev allows `DEV_AUTH_BYPASS_USER_ID=<uuid>` to skip auth entirely.

**Upstream service calls (machine).** Per-organisation. Service-user credentials stored in the `OrganisationCredential` table — see "Credential lifecycle" below. The API never propagates an Arrears user's JWT into LWCA/Rentancy calls; every upstream call is authenticated as the organisation's service user.

Outlook authentication is a third path: single app-level credential for the shared mailbox, stored in env (local) or Secrets Manager (hosted). Not per-organisation in Phase 1 — one mailbox serves all configured orgs.

## Credential lifecycle

How service-user tokens for LWCA + Rentancy stage flow through the system.

**Setup.** An Arrears admin opens the organisation config page and enters:

- `organisationId` (the upstream UUID, identical for both LWCA and Rentancy since they share Cognito)
- Initial access token
- Refresh token

On save, `OrganisationCredentialService.validateAndStore()`:

1. Encrypts both tokens
2. Calls `LwcaInvoiceClient.probe(orgId, accessToken)` — a `GET /v1/api/invoice?limit=1` against stage
3. Calls `RentancyTenancyClient.probe(orgId, accessToken)` — a `GET /v2/organisations/{orgId}/tenancies?limit=1`
4. If both succeed: persists row, emits `OrganisationCredentialsAdded` event, polling becomes active
5. If either fails: rejects save with the specific failure surface

**Refresh.** Every upstream call goes through `withFreshAccessToken(orgId, fn)`:

```
1. Load credential row for orgId
2. If accessTokenExpiresAt > now + 2 min → use as-is
3. Else: call Cognito InitiateAuth with REFRESH_TOKEN_AUTH, get new access token
4. Persist new access token + new expiresAt
5. Invoke fn(accessToken)
```

Refresh is concurrency-safe: an advisory lock on `(orgId, 'token_refresh')` prevents two parallel refreshes burning the refresh token. On 401 from upstream mid-call, retry once after forced refresh, then propagate.

**Rotation.** Refresh tokens themselves expire (Cognito default 30 days). When refresh fails with `NotAuthorizedException`, the service:

1. Raises `OrganisationFlag.CREDENTIALS_EXPIRED` (new flag, sibling of `EscalationFlag` but at org level — to be added to schema)
2. Halts polling for that organisation
3. Surfaces a banner on the Arrears config page prompting re-entry
4. Continues serving cached data for read-only operations

**Storage.** Per the previous discussion: `OrganisationCredential` table with `refreshTokenEncrypted`, `accessTokenEncrypted`, `accessTokenExpiresAt`, plus `createdBy`, `rotatedAt`, `rotatedBy`. Encryption is via a `CredentialStore` interface with two implementations:

- **Local POC:** `LocalCredentialStore` — AES-256-GCM with a key from `CREDENTIAL_ENCRYPTION_KEY` env var
- **Hosted POC:** `SecretsManagerCredentialStore` — DB row stores the secret ARN; KMS-backed Secrets Manager holds the ciphertext

Same `CredentialStore` interface; configuration picks the implementation. The encrypted columns exist either way (the local impl writes into them; the hosted impl writes the ARN into a different column and leaves the encrypted ones null).

This means **`OrganisationCredential` is a small addition to the canonical model**:

```prisma
model OrganisationCredential {
  organisationId           String   @id
  organisation             Organisation @relation(fields: [organisationId], references: [id])

  storageBackend           CredentialStorageBackend
  // For LOCAL backend:
  accessTokenEncrypted     Bytes?
  refreshTokenEncrypted    Bytes?
  // For SECRETS_MANAGER backend:
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
```

This wasn't in `canonical-data-model.md` v1 — I'll fold it in when we reconcile.

## Scheduled jobs

All jobs are NestJS providers decorated with `@Cron()`. Single-process for POC. Every job execution writes a `SyncJobRun` row for audit.

| Job                          | Frequency                 | Responsibility                                                                |
| ---------------------------- | ------------------------- | ----------------------------------------------------------------------------- |
| `LwcaInvoicePollJob`         | Every 15 min, per org     | Pull arrears invoices for each org, upsert charges, open/close cases          |
| `RentancyTenancyRefreshJob`  | Every 60 min, per org     | Refresh tenancy + contact data for tenancies with active cases                |
| `ChaseTickJob`               | Hourly at :05             | Compute today's WD events per charge, write `ChaseScheduleEntry` rows         |
| `DailyDigestJob`             | Daily 09:00 Europe/London | For each case with fired-today entries, generate a draft to review queue      |
| `OutlookInboundPollJob`      | Every 5 min               | Pull new messages from shared mailbox, route to inbound pipeline              |
| `WorkingDayCalendarSync`     | Daily 02:00 UTC           | Refresh gov.uk bank-holidays cache                                            |
| `EscalationReevaluationJob`  | Daily 09:30 Europe/London | Re-check S8 thresholds; raise/clear flags                                     |
| `TokenExpiryWarningJob`      | Daily 08:00 Europe/London | Warn 7 days before refresh token expiry                                       |

Jobs are idempotent. Re-running any of them within their window produces no duplicate side effects. Idempotency keys: LWCA invoice id, Outlook message id, `(chargeId, stage)` for schedule entries, `(caseId, workingDay)` for digests.

For demo control, `DEV_TOOLS_ENABLED=true` exposes:

- `POST /dev/advance-clock` — sets a process-wide virtual "now" forward by N working days; cadence tick + digest run synchronously against it
- `POST /dev/force-sync/:orgId` — runs LWCA + Rentancy polls inline
- `POST /dev/seed-fixture-emails/:caseId` — drops fixture inbound messages onto the case for testing pre-filter and AI paths

## Core flows

### Flow 1 — Polling + case lifecycle

```
LwcaInvoicePollJob fires (every 15 min, per configured org)
    │
    ├─▶ withFreshAccessToken(orgId)
    │       │
    │       └─▶ LwcaInvoiceClient.listArrears(orgId)
    │               GET /v1/api/invoice?type=INBOUND&isArrear=true&statuses=UNPAID,PARTIALLY_PAID,PARTIALLY_RECONCILED
    │
    ├─▶ For each invoice returned:
    │       1. Upsert Charge by lwcaInvoiceId
    │       2. If new charge AND no active case for tenancyId:
    │             create Case with status=ACTIVE
    │             emit CaseEvent CASE_OPENED
    │             trigger one-off Rentancy refresh for the tenancy
    │       3. If new charge AND active case exists:
    │             attach to existing case
    │             emit CaseEvent CHARGE_ADDED
    │       4. If existing charge:
    │             update lastKnownRemainAmount, lastKnownStatus
    │             emit CaseEvent CHARGE_SYNCED
    │             if remain=0 and status in (PAID, RECONCILED):
    │                 emit CHARGE_FULLY_PAID
    │
    ├─▶ For each active case touched:
    │       recompute lastKnownBalancePence (sum of charge remains)
    │       if balance == 0 and no other active charges:
    │             close case (status=CLOSED, closedAt=now)
    │             emit CaseEvent CASE_CLOSED
    │
    └─▶ Write SyncJobRun audit row
```

### Flow 2 — Cadence tick + daily digest

```
ChaseTickJob fires (hourly)
    │
    └─▶ For each charge in arrears (lastKnownStatus IN UNPAID/PARTIALLY_*):
            recompute workingDaysOverdue against today (or virtual now)
            if WD matches WD3/WD5/WD8/WD14 thresholds AND no ChaseScheduleEntry exists for this (charge, stage):
                create ChaseScheduleEntry with dueAt=today_09:00_London, firedAt=NULL
                advance charge.currentStage to AWAITING_<next>
                emit CaseEvent CHASE_STAGE_ADVANCED

DailyDigestJob fires (daily 09:00 Europe/London)
    │
    └─▶ For each case with one or more ChaseScheduleEntry firedAt=NULL and dueAt<=now:
            check breathing-space flag → skip tenant track entirely, mark entries skipped
            check case closed → mark entries skipped
            pick most-severe stage among entries (WD14 > WD8 > WD5 > WD3)
            re-fetch each entry's charge from LWCA for live balance (rule layer)
            render template with consolidated case balance + per-charge breakdown
            create Communication direction=OUTBOUND status=AWAITING_APPROVAL
                consolidatedStage = <most severe>
                link to all charges in the digest
            create ReviewQueueItem kind=OUTBOUND_DRAFT_APPROVAL priority=NORMAL
                (priority HIGH if includes WD14, URGENT if S8 eligible)
            mark all included ChaseScheduleEntry firedAt=now
            emit CaseEvent COMMUNICATION_DRAFTED for the case
```

### Flow 3 — Inbound message routing

```
OutlookInboundPollJob fires (every 5 min)
    │
    └─▶ OutlookGraphClient.listNewMessages(since=last_poll_at)
            For each message:
                idempotency check on outlookMessageId — skip if seen
                Match sender email → Contact (organisation-scoped)
                If no match: log "unmatched inbound" and store as orphan (review later)
                If matched: find active case for the contact's tenancy
                If no active case: store on closed case OR as case-less message; do not invoke AI
                If active case:
                    create Communication direction=INBOUND status=RECEIVED
                    emit CaseEvent COMMUNICATION_RECEIVED
                    pass to InboundPipeline

InboundPipeline
    │
    ├─▶ Step 1: Deterministic pre-filter (see docs/ai-decision-spec.md)
    │       Run hard-trigger regex/keyword scan on message body
    │       If any hard trigger matches:
    │             create ClassificationResult with preFilterMatched=true, preFilterTriggerKind set
    │             raise EscalationFlag of corresponding kind
    │             create ReviewQueueItem kind=HARD_TRIGGER_ESCALATION priority=URGENT
    │             emit CaseEvent HARD_TRIGGER_MATCHED
    │             halt all auto-chase on the tenant track for this case
    │             STOP — Claude is never invoked
    │
    ├─▶ Step 2: Claude classification (only reached if no hard trigger)
    │       Redact PII per ai-decision-spec
    │       Call AnthropicClient.classify(message, caseContext) using Haiku
    │       Persist ClassificationResult with sentiment, intent, confidence
    │       Log token usage and cost
    │
    └─▶ Step 3: Routing on confidence
            If confidence ≥ orgConfig.aiConfidenceThreshold AND intent ∈ {AUTO-DRAFTABLE intents}:
                Call AnthropicClient.draftReply(message, caseContext) using Sonnet
                Create OUTBOUND Communication status=AWAITING_APPROVAL, draftedByAi=true
                Create ReviewQueueItem kind=OUTBOUND_DRAFT_APPROVAL priority=NORMAL
            Else:
                Create ReviewQueueItem kind=INBOUND_LOW_CONFIDENCE priority=HIGH
                Raise EscalationFlag AI_CONFIDENCE_FAILURE
```

The hard-trigger pre-filter is a safety boundary. Wrap-around tests in `__tests__/inbound-pipeline.spec.ts` assert: for every fixture inbound that matches a hard trigger, Anthropic SDK is never called (mock asserts zero invocations).

### Flow 4 — Review queue approval

```
Human user opens Review Queue page
    │
    ├─▶ List filtered by organisation, priority, kind
    │
    └─▶ Open a draft (kind=OUTBOUND_DRAFT_APPROVAL):
            See: consolidated body, per-charge breakdown, live balance re-fetched on open,
                 AI confidence + rationale, case timeline preview
            Actions:
                APPROVE → Communication.status=APPROVED → send via Outlook
                        → on success: status=SENT, emit COMMUNICATION_SENT, mark RQI resolved
                        → on failure: status=SEND_FAILED, surface error, leave RQI open
                EDIT + APPROVE → update bodyMarkdown/Html, then APPROVE path
                REJECT → Communication.status=REJECTED, RQI resolved with reason
```

When approving, the system re-fetches each linked charge's live `remainAmount` before sending. If the balance has materially changed since draft (e.g. tenant paid since the draft was queued), the system blocks send and surfaces "balance has changed since draft — regenerate?" with a regenerate action.

### Flow 5 — Breathing space toggle

```
Handler opens case detail, clicks "Activate breathing space"
    │
    ├─▶ Confirmation modal: select source (FORMAL_NOTIFICATION | TENANT_MENTIONED), optional note
    │
    └─▶ EscalationService.activateBreathingSpace(caseId, source, userId):
            raise EscalationFlag kind=BREATHING_SPACE
            set Case.breathingSpaceActive=true
            for each pending ChaseScheduleEntry firedAt=NULL on this case:
                mark skippedReason=BREATHING_SPACE_ACTIVE, firedAt=now
            for each Communication status=AWAITING_APPROVAL OR APPROVED:
                if recipientRole=TENANT and status != SENT:
                    auto-reject with reason "breathing space active"
                    resolve linked ReviewQueueItem
            emit CaseEvent BREATHING_SPACE_ACTIVATED
            (guarantor track communications continue normally per BRD)

Deactivation reverses the toggle. Past skipped entries are not retroactively re-fired —
the cadence picks up from the next scheduled tick.
```

## Deployment topology — local

`docker-compose.yml` brings up four containers. Backend and frontend run as host processes via `pnpm dev` for fast iteration.

```
┌──────────────────────────────────────────────────────────────┐
│  Developer laptop                                            │
│                                                              │
│  ┌────────────────┐    ┌────────────────┐                    │
│  │ frontend       │    │ backend        │                    │
│  │ Vite dev       │───▶│ NestJS         │                    │
│  │ :5173          │    │ :3000          │                    │
│  └────────────────┘    └─────┬──────────┘                    │
│                              │                               │
│              ┌───────────────┼───────────────┐               │
│              ▼               ▼               ▼               │
│        ┌──────────┐   ┌─────────────┐  ┌─────────────┐       │
│        │ Postgres │   │ Mailhog     │  │ (real)      │       │
│        │ :5432    │   │ SMTP :1025  │  │ LWCA stage  │       │
│        │          │   │ UI   :8025  │  │ Rentancy    │       │
│        └──────────┘   └─────────────┘  │ Outlook     │       │
│                                        │ Anthropic   │       │
│                                        └─────────────┘       │
└──────────────────────────────────────────────────────────────┘
```

`OUTBOUND_MODE=mailhog` routes outbound mail to Mailhog for local capture. `OUTBOUND_MODE=outlook` actually sends via Graph (used only when explicitly testing send path).

Local environment variables (`.env.example` in repo):

```
DATABASE_URL=postgres://arrears:arrears@localhost:5432/arrears
ANTHROPIC_API_KEY=...
ANTHROPIC_SPEND_CAP_GBP_DAILY=5
OUTLOOK_TENANT_ID=...
OUTLOOK_CLIENT_ID=...
OUTLOOK_CLIENT_SECRET=...
OUTLOOK_SHARED_MAILBOX=arrears-test@<lofty-tenant>
OUTBOUND_MODE=mailhog
INTEGRATION_MODE=stage              # or fixtures
CREDENTIAL_ENCRYPTION_KEY=<32 bytes base64>
LWCA_STAGE_BASE_URL=https://stage.uk.loftyworks.com
RENTANCY_STAGE_BASE_URL=https://api.stage.uk.loftyworks.com   # TBC actual host
COGNITO_USER_POOL_ID=<lofty stage pool id>
COGNITO_CLIENT_ID=<lofty stage client id>
ARREARS_COGNITO_USER_POOL_ID=<arrears pool id>
ARREARS_COGNITO_CLIENT_ID=<arrears client id>
DEV_AUTH_BYPASS_USER_ID=             # optional
DEV_TOOLS_ENABLED=true
LOG_LEVEL=debug
```

## Deployment topology — hosted POC (AWS)

```
                          ┌──────────────────┐
              users ─────▶│ Route53 + ACM    │
                          │ arrears.example  │
                          └────────┬─────────┘
                                   │
                          ┌────────▼─────────┐
                          │ Application LB   │
                          │ HTTPS :443       │
                          └────────┬─────────┘
                                   │
                ┌──────────────────┼──────────────────┐
                ▼                                     ▼
       ┌────────────────┐                    ┌────────────────┐
       │ ECS Fargate    │                    │ ECS Fargate    │
       │ frontend       │                    │ backend        │
       │ static + SPA   │                    │ NestJS         │
       │ task: 0.25vCPU │                    │ task: 0.5 vCPU │
       └────────────────┘                    └───────┬────────┘
                                                     │
                          ┌──────────────────────────┼──────────────────────────┐
                          ▼                          ▼                          ▼
                ┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
                │ RDS Postgres     │       │ Secrets Manager  │       │ CloudWatch       │
                │ db.t4g.micro     │       │ per-org creds    │       │ logs + dashboard │
                │ 20GB gp3         │       │ shared mailbox   │       │                  │
                │ daily backup     │       │ anthropic key    │       │                  │
                └──────────────────┘       └──────────────────┘       └──────────────────┘
```

Single Fargate task per service for POC — no autoscaling, no multi-AZ. Frontend is static assets in S3 fronted by CloudFront in a more mature version, but for POC simplicity it runs as a tiny nginx Fargate task serving the Vite build output.

RDS in a private subnet. Backend task in a private subnet with NAT for egress to LWCA stage, Rentancy stage, Microsoft Graph, Anthropic. Public ALB in public subnet routes to the backend (via path `/api/*`) and frontend (everything else).

Secrets:

- `arrears/{env}/anthropic` — API key
- `arrears/{env}/outlook` — client id, client secret, tenant id, shared mailbox UPN
- `arrears/{env}/cognito-arrears-pool` — Arrears user pool config
- `arrears/{env}/db` — RDS master credentials
- `arrears/{env}/org/{orgId}/upstream-credentials` — access + refresh token for that org's LWCA/Rentancy access

Backend IAM role grants `secretsmanager:GetSecretValue` on `arrears/{env}/*` only.

GitHub Actions pipeline:

```
push to main →
    lint + typecheck + test (Postgres in service container)
    build backend image → push to ECR
    build frontend → upload to S3 (or build frontend image)
    update ECS task definitions
    deploy to stage cluster
    smoke test (health checks + one read API)
```

## Observability

**Logs.** Pino JSON to stdout. CloudWatch Logs in hosted. Each log line carries `requestId`, `organisationId` (when known), `caseId` (when known), and `actor` (`system` for jobs, `user:<id>` for HTTP).

**Metrics (hosted only, CloudWatch).** Minimal set for POC:

- `arrears.cases.active` (gauge, per org)
- `arrears.review_queue.pending` (gauge, per org, per kind)
- `arrears.chase.fired` (counter, per stage)
- `arrears.outbound.sent` (counter)
- `arrears.outbound.send_failed` (counter)
- `arrears.upstream.4xx` (counter, per integration)
- `arrears.upstream.5xx` (counter, per integration)
- `arrears.anthropic.cost_gbp` (counter)
- `arrears.anthropic.tokens` (counter, per direction)
- `arrears.hard_triggers.matched` (counter, per trigger kind)

**Anthropic spend cap.** `ANTHROPIC_SPEND_CAP_GBP_DAILY` enforced in the client wrapper. On cap breach: subsequent classify/draft calls fail with a typed error; pre-filter still runs (it doesn't touch Anthropic); affected inbound messages go to the review queue as `INBOUND_LOW_CONFIDENCE` with reason "spend cap exceeded".

**Health.** `GET /health` returns `{ db: 'ok', anthropic: 'ok'|'capped', lwca: 'ok'|'degraded' }`. Anthropic ping is shallow (no actual API call), LWCA ping is a HEAD against the base URL.

## Error handling philosophy

**Upstream failures fail loudly to the audit log, quietly to the user.** A polling job that can't reach LWCA writes a `SyncJobRun.status=FAILED` row, logs the error, increments a counter, and exits its tick. The next tick tries again. Users see "last sync: N minutes ago" on the case header. No alert spam, no retries inside a single tick.

**User-facing errors are typed.** All API errors return a `{ code, message, details? }` envelope. The frontend renders by `code`. `CREDENTIALS_EXPIRED`, `BALANCE_CHANGED_SINCE_DRAFT`, `BREATHING_SPACE_ACTIVE`, etc.

**Idempotency over compensation.** All side-effecting jobs are safe to re-run. We don't write compensating actions for partial failures — we re-run the job. The schedule table, the message tables, and the canonical model all support this.

## What this doesn't have

- **No message queue.** No SQS, no Redis. Jobs read DB, write DB, that's it. SQS becomes worth it when polling cadence is fast enough that direct DB pressure matters, or when we want decoupled retry semantics. Not yet.
- **No internal event bus.** NestJS in-process events (`EventEmitter2`) are used for module decoupling, but there's no Kafka, EventBridge, or similar.
- **No caching layer.** Per the live-balance rule, the things we'd cache are the things we mustn't cache. List views read directly from Postgres; pagination caps the cost.
- **No multi-region.** Single AWS region. London (eu-west-2) to match Lofty.
- **No service mesh / sidecars.** Plain Fargate tasks.

These choices are deliberate — they keep the POC small enough to be built and operated by one engineer. They're not the right answer for production scale.

## Open items

- **Rentancy stage base URL** — need confirmation; `api.stage.uk.loftyworks.com` is a guess from the LWCA pattern. The Rentancy serverless config in the repo we read points at API Gateway URLs which are environment-specific.
- **Cognito pool sharing** — LWCA and Rentancy *appear* to share the same user pool (both decorate handlers with the same Cognito authorizer), but to be confirmed. If they don't, the org credential row needs two token pairs, not one.
- **Outlook shared mailbox identity** — actual UPN and Azure AD tenant ID, plus admin consent flow for `Mail.Read`/`Mail.Send` with `ApplicationAccessPolicy` scoped to that mailbox.
- **AWS account allocation** — placeholder until allocated. Affects nothing in the build, but IaC (Terraform planned, not in scope for this doc) needs an account to target.
