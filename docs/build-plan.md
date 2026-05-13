# Build Plan

A sequenced list of small commits for Claude Code to make, with explicit "done when" criteria. Each step assumes the previous step is complete. Don't skip ahead; the dependencies are real.

Each step is approximately 0.5–2 hours of focused work for an experienced engineer. They're sized so a failed step is cheap to revert and a successful one can be reviewed before the next starts.

When in doubt: re-read the relevant doc, ask before deviating, prefer the smaller commit over the larger one.

## Phase 0 — Bootstrap

### Step 0.1 — Monorepo skeleton

Set up the empty repo structure. Land:
- `package.json` at root with pnpm workspaces (`backend`, `frontend`, `shared-canonical`)
- `pnpm-workspace.yaml`
- `.gitignore` (Node, env, build artifacts)
- `.editorconfig`, `.prettierrc`, `eslint.config.js` (shared config at root)
- `README.md` (minimal — points at `CLAUDE.md`)
- `tsconfig.base.json` at root, extended by each package

**Done when:** `pnpm install` succeeds with no packages yet, just the workspace config.

### Step 0.2 — Docker Compose

`docker-compose.yml` at root with:
- `postgres:16` exposed on 5432, `arrears` database, `arrears`/`arrears` creds
- `mailhog/mailhog` exposed on 1025 (SMTP) and 8025 (UI)
- A volume for Postgres data persistence

**Done when:** `docker compose up -d` brings both containers up; `psql -h localhost -U arrears -d arrears` connects; `http://localhost:8025` shows Mailhog UI.

### Step 0.3 — Shared canonical package

`shared/canonical/`:
- `package.json` with Zod, TypeScript as deps
- `src/index.ts` re-exporting from `src/case.ts`, `src/charge.ts`, etc.
- The Zod schemas from `docs/canonical-data-model.md`

**Done when:** `pnpm --filter shared-canonical typecheck` passes; importing types from another workspace package works.

### Step 0.4 — NestJS backend skeleton

`backend/`:
- `package.json` with NestJS, Prisma, `@nestjs/schedule`, Pino, Zod, Vitest, Testcontainers
- `src/main.ts` boots the app, picks up `LOG_LEVEL`, exposes `:3000`
- `src/app.module.ts` empty for now
- `tsconfig.json` extending root
- `.env.example` with placeholder values from `docs/architecture.md`
- `GET /health` endpoint returning `{ status: 'ok' }`

**Done when:** `pnpm --filter backend dev` starts the API; `curl localhost:3000/health` returns 200.

### Step 0.5 — Prisma init

`backend/src/prisma/`:
- `schema.prisma` matching `docs/canonical-data-model.md` exactly (including the amendments — `OrganisationCredential`, `CredentialStorageBackend`)
- `npm run prisma:migrate:dev --name initial` produces the first migration
- The raw-SQL migrations from the doc (partial unique index, conditional charge index) added as follow-up SQL files in `migrations/` and applied via Prisma's migration mechanism

**Done when:** `pnpm --filter backend prisma:migrate:dev` succeeds against the local Postgres; `pnpm --filter backend prisma:studio` opens and shows all tables empty.

### Step 0.6 — Vite + React skeleton

`frontend/`:
- `package.json` with React, Vite, TypeScript, Tailwind, shadcn/ui (installed as needed), TanStack Query, React Router, Zod
- Tailwind + shadcn configured
- One page (`/`) saying "Arrears POC"
- Vite proxy to backend `:3000` for `/api/*`

**Done when:** `pnpm --filter frontend dev` starts on `:5173`, shows the placeholder page, and fetching `/api/health` via the proxy works.

### Step 0.7 — Pino + structured logging

`backend/src/common/logger/` module providing Pino. Request middleware logs request id, method, path, status, duration. JSON output.

**Done when:** Hitting `/health` produces a structured log line in stdout.

## Phase 1 — Foundation modules

### Step 1.1 — Working-day calendar module

Implement `backend/src/common/working-day/` per `docs/working-day.md`:
- Service with all four methods
- HTTP loader fetching gov.uk JSON, with file cache for local dev
- `@Cron('0 2 * * *')` job for daily refresh
- Comprehensive unit tests (the cases listed in the doc)

**Done when:** All tests pass; on cold start with no cache, fetches successfully; `service.workingDaysOverdue` returns correct values for the Easter and bank-holiday edge cases.

### Step 1.2 — Auth module (Arrears user pool)

Backend:
- `backend/src/modules/auth/` with `AuthGuard` based on JWT
- JWKS-backed verification
- `DEV_AUTH_BYPASS_USER_ID` short-circuit
- `@CurrentUser()` decorator extracting from `req.user`

Frontend:
- `frontend/src/lib/auth.tsx` with `AuthProvider` storing token in memory
- `LoginPage` (Cognito hosted UI redirect; for POC can be a simple form against Cognito InitiateAuth)
- `useAuth()` hook
- Authenticated `apiClient` adding bearer header

**Done when:** With the bypass enabled, the frontend can call `/api/me` and get user info from the JWT. With bypass off and Cognito configured, real login works end-to-end.

### Step 1.3 — Credential store interface and local implementation

`backend/src/integrations/credential-store/`:
- `CredentialStore` interface
- `LocalCredentialStore` using AES-256-GCM with `CREDENTIAL_ENCRYPTION_KEY`
- `SecretsManagerCredentialStore` stubbed (throws "not implemented") for hosted
- Provider in DI based on env

**Done when:** Round-trip encrypt-then-decrypt of a token works; the store can be injected; passing a wrong key fails decryption.

### Step 1.4 — Cognito refresh helper

`backend/src/integrations/cognito/`:
- Wrapper around `@aws-sdk/client-cognito-identity-provider`
- `refresh(refreshToken)` returns new access token + expiry
- `withFreshAccessToken(orgId, fn)` per `docs/auth-and-credentials.md`
- Postgres advisory lock for refresh concurrency

**Done when:** Unit-tested with the SDK mocked; the lock prevents two parallel refreshes from both calling Cognito; on `NotAuthorizedException`, raises `CredentialsExpiredError`.

## Phase 2 — Configuration

### Step 2.1 — Organisations module

`backend/src/modules/organisations/`:
- `OrganisationService` CRUD on `Organisation` rows
- `OrganisationConfigService` CRUD on `OrganisationConfig`, with defaults applied on create
- `OrganisationCredentialService` storing tokens via `CredentialStore`
- REST endpoints under `/api/organisations`
- Probe service that calls LWCA and Rentancy stubs (real call comes in Phase 3)

**Done when:** Can create an organisation via API, save credentials, retrieve config, and call the probe endpoint which returns `{ overall: 'FAILED', lwca: ..., rentancy: ... }` because integrations aren't real yet.

### Step 2.2 — Frontend configuration page

`frontend/src/pages/OrganisationsList.tsx` + `OrganisationConfig.tsx`:
- List of configured orgs
- Add-org form: organisationId, access token, refresh token, name
- On save: probe shown side-by-side per upstream, save-anyway with confirmation
- Config form: all the fields from `OrganisationConfig` with sensible UI (sliders for thresholds, code editors for templates)
- Credentials card: masked, with "rotate" action and "last used" / "expires" indicators

**Done when:** Admin can add an org, save credentials, edit config, see masked credentials. UI calls the API. Probes can fail gracefully and admin can save anyway.

## Phase 3 — Upstream integrations

### Step 3.1 — LWCA invoice client

`backend/src/integrations/lwca/`:
- `LwcaInvoiceClient` with `listArrears(orgId)`, `probe(orgId, accessToken)`
- `LwcaInvoiceMapper` converting upstream DTO → canonical `Charge` + tenancy hints
- All calls go through `withFreshAccessToken`
- `FixtureLwcaInvoiceClient` reading from `fixtures/lwca/*.json`
- DI provider picks between real and fixture based on `INTEGRATION_MODE`
- Tests: fixture-based for the mapper; mocked-SDK for the real client

**Done when:** With `INTEGRATION_MODE=fixtures`, calling the client returns canonical charges from disk. With `INTEGRATION_MODE=stage` and a real probe token, it actually calls stage and returns canonical charges.

### Step 3.2 — Rentancy client

`backend/src/integrations/rentancy/`:
- `RentancyTenancyClient` with `getTenancy(orgId, tenancyId)`, `getContact(orgId, contactId)`, `probe(orgId, accessToken)`
- Mapper for both
- `FixtureRentancyClient`
- Same DI pattern as LWCA

**Done when:** Same as 3.1 for Rentancy.

### Step 3.3 — Wire probes into the credential save path

Replace the stubbed probe from 2.1 with real client calls. Validate-on-save now actually checks both upstreams. Update the frontend to surface specific error messages.

**Done when:** Admin pastes a real stage token, save validates, persists. Admin pastes a junk token, save shows which upstream rejected it.

## Phase 4 — Case lifecycle

### Step 4.1 — Cases module — open/close

`backend/src/modules/cases/`:
- `CaseService.openOrAttach(orgId, charge)` per R1
- `CaseService.recomputeAndMaybeClose(caseId)` per R2
- `CaseService.recomputeBalance(caseId)` — sum of charge remains
- Repository methods
- REST endpoints: `GET /api/organisations/:orgId/cases`, `GET /api/cases/:id`
- Timeline writes (`CaseEvent`) on every state change

**Done when:** Given a fixture set of charges, calling `openOrAttach` for each produces correct cases. Case closes when all charges paid. Partial unique index prevents two active cases per tenancy.

### Step 4.2 — Charges module

`backend/src/modules/charges/`:
- Upsert by `lwcaInvoiceId`
- Stage advancement helper
- Repository

**Done when:** Re-running upsert with the same invoice twice produces no duplicates. Stage column updates atomically.

### Step 4.3 — LWCA invoice polling job

`backend/src/modules/cases/jobs/lwca-invoice-poll.job.ts`:
- `@Cron` runs every 15 minutes
- Iterates organisations with active credentials
- Calls LWCA, maps to charges, runs `openOrAttach` for new, updates existing
- Recomputes case balances after every batch
- Writes `SyncJobRun` audit row

**Done when:** With fixture data, running the job creates cases and charges correctly. Re-running it doesn't duplicate. With `INTEGRATION_MODE=stage` it actually pulls from stage.

### Step 4.4 — Rentancy refresh on case open

When a case opens, fetch tenancy + all contacts (tenants + guarantors). Persist `Tenancy` + `Contact` + `TenancyContact` rows.

Also: `RentancyTenancyRefreshJob` running hourly to refresh all active cases.

**Done when:** Opening a case populates tenancy and contact data. Hourly job refreshes them.

### Step 4.5 — Frontend cases list + case detail

`frontend/src/pages/CasesList.tsx`:
- Table: tenant, property, balance, days overdue, stage, flags, last synced
- Filters: org, status, flag
- Sort, pagination
- Manual "sync now" button calling the dev-tools endpoint

`frontend/src/pages/CaseDetail.tsx`:
- Header: tenant, property, balance, S8 flag, breathing-space toggle
- Charges table: per-charge stage, due date, gross, remain, days overdue
- Timeline: rendered from `CaseEvent` rows
- Communications: empty for now
- "Refresh from upstream" action

**Done when:** Both pages render real data pulled from stage (or fixtures). Sync-now triggers polling and pages reflect new state on refresh.

## Phase 5 — Chase cadence and digest

### Step 5.1 — Chase tick job

`backend/src/modules/chase/jobs/chase-tick.job.ts`:
- Runs hourly
- For each charge in arrears states, computes `workingDaysOverdue`
- For each crossed WD threshold (per org config), creates `ChaseScheduleEntry` if not exists
- Advances `Charge.currentStage`

**Done when:** With manually-aged fixture charges, running the job creates the right schedule entries. Idempotent.

### Step 5.2 — Daily digest job

`backend/src/modules/chase/jobs/daily-digest.job.ts`:
- Runs at 09:00 Europe/London
- For each case with `firedAt=NULL` entries due today, generates one digest
- Picks most-severe stage
- Renders the template with case + charges context
- Creates a Communication (`status=AWAITING_APPROVAL`)
- Creates ReviewQueueItem
- Marks all included entries `firedAt=now`
- Respects breathing space (skips with reason)

**Done when:** Given a case with multiple charges at different stages, running the digest produces one Communication using the most-severe template, lists all charges, and marks entries fired.

### Step 5.3 — Templates

Seed the default templates from the BRD into `OrganisationConfig` defaults. Provide a renderer in `backend/src/modules/chase/template-renderer.ts` using a Mustache-style library.

**Done when:** A template with all the variables renders correctly against a real case. Missing variables raise rendering errors, not silent blanks.

### Step 5.4 — Dev tools — advance clock

`backend/src/modules/dev-tools/`:
- `POST /dev/advance-clock` accepting `{ days: 3 }`
- A `Clock` service that everywhere else uses for `now()` instead of `new Date()`
- When dev tools are off, `Clock` returns real time

**Done when:** Calling advance-clock moves the system's "now". Chase tick + daily digest, run synchronously after, behave as if N working days have passed.

### Step 5.5 — Review queue (read + approve UI)

Backend:
- `ReviewQueueService` with list, approve, edit, reject
- REST endpoints under `/api/review-queue`
- Approve action: re-sync charges per R9; if balance unchanged, send via Outlook (next step); if changed, return 409 with "balance changed" code

Frontend:
- `frontend/src/pages/ReviewQueue.tsx` listing items
- Click → detail with the draft body, per-charge breakdown, AI rationale if present
- Approve / Edit-then-approve / Reject actions
- "Balance changed" error renders a "regenerate" button

**Done when:** Drafts appear in the queue, approving without changes returns a successful response (send happens in next step), and the balance-changed flow triggers when the live balance differs.

## Phase 6 — Outbound send

### Step 6.1 — Outlook client

`backend/src/integrations/outlook/`:
- `OutlookGraphClient` with `sendMail`, `listInbound`, `getMessage`, `markRead`, `moveTo`
- Mailhog SMTP variant for local
- Mode switch via `OUTBOUND_MODE`

**Done when:** With `OUTBOUND_MODE=mailhog`, sending a test mail lands in Mailhog. With `OUTBOUND_MODE=outlook`, sending a test mail to a real address arrives.

### Step 6.2 — Wire approve → send

Approve handler now actually sends. On success, persists `sentAt` and `outlookSentMessageId`. On failure, persists `sendErrorJson` and surfaces error.

**Done when:** Approving a draft locally lands the email in Mailhog. The Communication row reflects sent state.

## Phase 7 — Inbound + AI

### Step 7.1 — Outlook inbound polling

`backend/src/modules/inbound/jobs/outlook-inbound-poll.job.ts`:
- Every 5 minutes
- Pulls messages since cursor (with 2-min overlap)
- Idempotency on `outlookMessageId`
- Matches sender → Contact (org-aware) → Case
- Creates inbound Communication
- Routes to inbound pipeline (next steps)

**Done when:** Putting a fixture email in Mailhog or sending one to the real shared mailbox results in a Communication row on the right case.

### Step 7.2 — Pre-filter

`backend/src/modules/ai/hard-triggers.ts` with the regex/keyword list from `docs/ai-decision-spec.md`. `PreFilterService.scan(message)` returns `{ matched: true, trigger: 'HARDSHIP_INDICATED', keyword: '...' }` or `{ matched: false }`.

Integration tests for every fixture in `fixtures/outlook/inbound-hardship.eml`, `inbound-mental-health.eml`, etc., asserting correct trigger kind.

**Done when:** All fixture hard-trigger emails match correctly. Routine emails do not match.

### Step 7.3 — Hard-trigger escalation flow

On pre-filter match: raise flag, halt cadence, create URGENT review item, emit timeline event. Anthropic SDK MUST NOT be called.

Test: mock `AnthropicClient` and assert it's never invoked for any hard-trigger fixture.

**Done when:** Hard-trigger fixtures route to escalation with zero Anthropic calls.

### Step 7.4 — Anthropic client wrapper

`backend/src/integrations/anthropic/`:
- Wrapper with model allowlist, pricing table, cost logging, spend cap enforcement, redactor assertion
- `classify(input)` and `draftReply(input)` methods

**Done when:** Both methods work against real Anthropic API in dev. Spend cap triggers a typed error when over. Redactor rejects PII-laden prompts in tests.

### Step 7.5 — PII redactor

`backend/src/modules/ai/redactor.ts` per `docs/ai-decision-spec.md`. `Redactor.redact(text)` returns text with patterns replaced. `Redactor.assertSafe(text)` throws if unredacted patterns remain.

**Done when:** All patterns in the doc redact correctly. `assertSafe` catches anything `redact` missed (regression for redactor bugs).

### Step 7.6 — Classification flow

For inbound messages that don't match pre-filter: call `AnthropicClient.classify`, persist `ClassificationResult`, log cost.

**Done when:** A non-trigger fixture email gets classified; sentiment and intent are sensible; cost is logged.

### Step 7.7 — Drafting flow + routing

Confidence ≥ threshold + intent in auto-draftable set → call `draftReply`, create OUTBOUND Communication `status=AWAITING_APPROVAL`, `draftedByAi=true`, create review item.

Otherwise → create `INBOUND_LOW_CONFIDENCE` review item, raise `AI_CONFIDENCE_FAILURE` flag.

`DISTRESSED` sentiment always routes to low confidence regardless.

**Done when:** Different fixtures take the right path. High-confidence routine emails get drafted replies. Complaints and unclear messages don't.

### Step 7.8 — Review queue for inbound

UI shows two kinds of review items: outbound drafts (existing) and inbound classifications (new). The inbound items show the original message, the classification, the rationale, and the suggested draft (if any).

**Done when:** Reviewer can see an inbound classification with the AI rationale, approve the draft reply (or edit it), or dismiss.

## Phase 8 — Operational polish

### Step 8.1 — Breathing space toggle

Backend service to activate/deactivate. Cascading effects per R7.

UI on case detail: toggle with confirmation modal.

**Done when:** Activating breathing space marks pending entries skipped, auto-rejects pending tenant drafts, clears S8 flag. Deactivating resumes normal flow.

### Step 8.2 — S8 evaluation job

`EscalationReevaluationJob` running daily at 09:30 Europe/London. Re-checks S8 eligibility for all active cases per R6. Raises and clears flags as needed.

Plus inline check inside the polling job (so S8 transitions are detected promptly on rent payments, not waiting until next day).

**Done when:** A balance crossing the threshold raises the flag within one poll cycle.

### Step 8.3 — Dev tools — seed fixtures

`POST /dev/seed-fixture-emails/:caseId` drops the fixture emails onto a case. Useful for the demo.

`POST /dev/force-sync/:orgId` runs the polling cycle inline.

**Done when:** Demo control panel works as described in `docs/poc-scope.md`.

### Step 8.4 — Token expiry warning

`TokenExpiryWarningJob` raises a banner 7 days before refresh token expiry. UI shows it on the org config page.

**Done when:** With a fixture credential whose `refreshTokenExpiresAt` is 5 days out, the warning appears.

### Step 8.5 — OpenAPI export + frontend client generation

Wire NestJS Swagger to emit an OpenAPI spec. Frontend has a `pnpm openapi:generate` script that re-runs from the spec.

**Done when:** Changing a backend response shape, running export + generate, produces matching frontend types.

## Phase 9 — Demo readiness

### Step 9.1 — Seed script for the demo

`backend/prisma/seed.ts` creates the demo organisation with default config. Documents how to obtain a stage token and add it via the UI.

**Done when:** Fresh checkout → docker compose up → migrations → seed → frontend up → admin can sign in, add the demo org with a real stage token, and start polling.

### Step 9.2 — Six demo scenarios

Verify all six demo scenarios from `docs/poc-scope.md` work end to end against stage:
1. Clean tenancy
2. Early arrears
3. Multi-charge case
4. S8 threshold
5. Hard-trigger inbound
6. Tenant with guarantor (guarantor visible, no parallel cadence)

**Done when:** Each scenario can be reproduced in under 5 minutes following a demo script.

### Step 9.3 — Demo script doc

`docs/demo-script.md` (new): step-by-step click-by-click guide for the stakeholder demo. Includes the talking points for each step.

**Done when:** A new engineer can run the demo from the script without prior knowledge.

## Phase 10 — Hosted POC (deferred until local POC is signed off)

Not detailed here. Architecture is in `docs/architecture.md`. Triggered when local POC is approved for hosted rollout.

---

## What you do at every step

1. Re-read the relevant doc section if there's any doubt about behaviour.
2. Write the test before or alongside the code.
3. Don't expand scope. If you discover something missing, write it down as a follow-up; don't sneak it into the current commit.
4. Commit message format: `[Phase X.Y] short description` so progress is trivially trackable.
5. When a step is ambiguous, ask. The docs are written to make the right answer obvious; if the answer isn't in there, that's a doc bug, not a build decision.
