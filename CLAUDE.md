# CLAUDE.md

Guidance for Claude Code working in the Arrears repo. Read this before any first action in a fresh context. If a rule here conflicts with what looks "obvious", the rule wins — ask before deviating.

## What this is

An arrears chasing application for UK lettings agents. The system pulls overdue charge data from upstream property management systems, runs a rule-driven cadence of chase communications, monitors inbound tenant replies via a shared Outlook mailbox, classifies them, and surfaces escalations to internal staff via a review queue.

**Status: local POC against LWCA stage.** Not production. Not customer-facing. Single internal demo audience.

The architecture is deliberately platform-agnostic. Upstream data is translated into a canonical internal model and all chase logic operates on the canonical model. Phase 1 sources are LoftyWorks Client Accounting (LWCA, the invoice endpoint) and the Rentancy API (tenancy + contact details). Phase 2 will add other CRM/PMS sources via the same mapping pattern. The canonical model is the contract — see `docs/canonical-data-model.md`.

## Tech stack

- **Backend**: NestJS 10 (Node.js 20 + TypeScript 5, strict mode)
- **Database**: PostgreSQL 16 via Prisma ORM
- **Frontend**: React 18 + Vite + TypeScript + shadcn/ui + Tailwind
- **Background jobs**: `@nestjs/schedule` for polling and cadence ticks (single-process, in the API; extract to a separate worker only when scale demands it)
- **AI**: `@anthropic-ai/sdk` calling Claude — Haiku for classification, Sonnet for drafting
- **Email**: `@microsoft/microsoft-graph-client` against a shared Outlook mailbox
- **Validation**: Zod, with schemas in `shared/canonical` imported by both backend and frontend
- **Logging**: Pino, structured JSON
- **Testing**: Vitest (unit) + Supertest (HTTP integration) + Testcontainers (Postgres in CI)

## Repo layout

```
/
├── CLAUDE.md                     this file
├── README.md                     human-facing setup
├── docs/                         see "Doc index" below
├── fixtures/                     sample LWCA, Rentancy, and inbound email payloads
├── backend/                      NestJS app: HTTP API + scheduled jobs
│   ├── src/
│   │   ├── modules/              one folder per domain (cases, chases, ai, review-queue, config)
│   │   ├── integrations/         lwca, rentancy, outlook, anthropic clients
│   │   ├── prisma/               schema.prisma, migrations, seed
│   │   └── common/               working-day calendar, money, errors, auth guards
│   └── test/
├── frontend/                     React + Vite
│   └── src/
│       ├── pages/                cases list, case detail, review queue, config
│       ├── components/
│       └── lib/                  API client (generated from OpenAPI), formatters
├── shared/canonical/             canonical types + Zod schemas, published as a workspace package
└── docker-compose.yml            Postgres + Mailhog (captures local outbound) + app
```

Monorepo via pnpm workspaces. Three packages: `backend`, `frontend`, `shared-canonical`.

## Common commands

```bash
# First-time setup
pnpm install
docker compose up -d postgres mailhog
pnpm --filter backend prisma:migrate:dev
pnpm --filter backend seed

# Run everything in dev
pnpm dev                            # runs backend + frontend + worker in parallel

# Run individually
pnpm --filter backend dev
pnpm --filter frontend dev

# Tests
pnpm test                           # all
pnpm --filter backend test          # backend unit
pnpm --filter backend test:e2e      # backend HTTP integration

# Database
pnpm --filter backend prisma:migrate:dev --name <description>
pnpm --filter backend prisma:studio

# Generate frontend API client from backend OpenAPI spec
pnpm --filter backend openapi:export
pnpm --filter frontend openapi:generate

# Lint and typecheck
pnpm lint
pnpm typecheck
```

## Hard rules — non-negotiable

These exist to prevent specific failure modes that have real-world consequences (regulatory, reputational, financial). Do not work around them.

1. **Never call LWCA production.** Only `https://stage.uk.loftyworks.com` and the equivalent Rentancy stage host. Production URLs must not appear in any code, env file, or test. The config loader rejects any host containing `.prod.` or matching the prod domains.

2. **All outbound tenant and guarantor communications go to the review queue. No auto-send in POC.** Even when AI confidence is high. The send path is gated behind explicit human approval in the UI. There is no "auto-send: true" flag in Phase 1 — adding one requires a separate decision and a documented rollout plan.

3. **Deterministic pre-filter runs before any LLM call on inbound messages.** Hard escalation triggers (hardship, mental health, breathing space, third-party involvement, dispute of liability, domestic circumstances) are detected by regex/keyword classifier and route directly to a handler. Claude is never invoked to "decide" whether to escalate on these. See `docs/ai-decision-spec.md`. If you find yourself prompting an LLM to "check if this is a hardship message", stop — that's the pre-filter's job and it's safety-critical.

4. **Never cache LWCA balances.** Every threshold check (S8 eligibility, partial-payment chase-stage logic, case-close evaluation) re-fetches the live invoice(s) from LWCA. The local `Charge` row stores the last-known snapshot for display and audit, but rule evaluation always goes through `LwcaInvoiceClient.refresh(chargeId)` first.

5. **All queries scoped by `organisationId`.** Multi-tenant from day one. Repository methods take `organisationId` as a required argument; controllers extract it from JWT claims. There is no "admin override" path.

6. **No secrets in code or git.** Anthropic API key, Microsoft Graph credentials, Cognito refresh tokens, DB passwords — all loaded from environment variables. Local: `.env` (gitignored). Hosted: AWS Secrets Manager. Provide `.env.example` with placeholder values.

7. **Working days = UK England & Wales bank holidays.** Fetched from `https://www.gov.uk/bank-holidays.json` (the `england-and-wales` division), cached daily. Working day arithmetic lives in `backend/src/common/working-day/` and is the only place that does this calculation. Do not inline weekday-skipping logic anywhere else.

8. **Don't reproduce or paraphrase tenant PII into LLM prompts beyond what's necessary.** When classifying an inbound message, the prompt receives the message body and minimal case context (charge amounts, days overdue, stage). It does not receive full name, full address, phone numbers, NI numbers, or anything from the contact record beyond the first name needed for greeting in a draft. Redact before prompt construction.

## Conventions

**Module pattern.** Each NestJS module under `backend/src/modules/<domain>/` has: `<domain>.module.ts`, `<domain>.controller.ts`, `<domain>.service.ts`, `<domain>.repository.ts`, `dto/`, and `__tests__/`. Repositories are the only thing that touches Prisma; services call repositories.

**Canonical types are the contract.** Anything crossing a module or service boundary uses types from `shared/canonical`. Integration clients (`lwca`, `rentancy`) have their own DTO types that mirror the upstream API verbatim, plus a transformer (`*.mapper.ts`) that produces canonical types. The rest of the system only sees canonical types. Adding a field to an upstream DTO without mapping it to canonical is fine; adding a field to canonical without a mapper update is a build error.

**Money is `bigint` representing pence.** Never `number`, never `float`. The canonical schema uses `z.bigint()`. Frontend formats with `Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' })`. LWCA returns `BigInteger` amounts already in pence — pass-through, no conversion.

**Dates are ISO 8601 strings at API boundaries, `Date` objects internally.** Working-day arithmetic operates on `Date`.

**Event-sourced case timeline.** Every state change on a case (charge added, charge synced, chase stage advanced, communication queued, communication sent, communication approved/rejected, payment promise created, escalation triggered, breathing space toggled, case closed) is appended to a `case_event` table with a typed `kind` and a JSON payload. Threshold checks that need "stage at point of event" read this timeline. Do not derive case state from the current row's columns alone — the timeline is the source of truth for audit and for rules like "stage at point of event, not stage at case open".

**Idempotency.** Polling jobs are idempotent — running twice in the same window must not double-send anything, double-create cases, or fire duplicate chase events. Use upserts keyed on natural identifiers (LWCA invoice id, Outlook message id), and guard outbound actions with a `(case_id, charge_id, working_day, stage)` uniqueness check.

**Feature flags via env vars in POC.** `ARREARS_AUTOSEND_ENABLED=false` is the master gate for rule #2 above. Even with the flag flipped, send is still routed via the review queue infrastructure — the flag just sets a default approval state.

**Tests in `__tests__/` next to the code.** Business rule tests are spec-style (`given... when... then...`) and live in `backend/src/modules/<domain>/__tests__/rules/`. There should be one test per rule in `docs/business-rules.md`, with the rule ID in the test name.

## Doc index

- `docs/poc-scope.md` — what's in/out for the local POC and the hosted POC, demo acceptance criteria
- `docs/architecture.md` — services, jobs, message flow, deployment topology
- `docs/canonical-data-model.md` — Prisma schema + Zod schemas, with field-level rationale
- `docs/integrations.md` — LWCA, Rentancy, Outlook clients: auth, polling, field mapping, inbound/outbound flow
- `docs/business-rules.md` — chase cadence, promise rules, partial payment, S8, breathing space — testable specs
- `docs/ai-decision-spec.md` — pre-filter, prompts, model selection, confidence, review queue contract
- `docs/working-day.md` — gov.uk source, caching, working-day arithmetic
- `docs/auth-and-credentials.md` — JWT against Cognito, service-user refresh-token flow for LWCA/Rentancy calls
- `docs/build-plan.md` — sequenced commit-sized steps for building the POC
- `docs/demo-script.md` — click-by-click stakeholder demo walkthrough for the six scenarios

## Build approach for Claude Code

Work in this order. Each step gets a working commit before the next starts.

1. Bootstrap: monorepo, NestJS skeleton, React skeleton, Prisma init, Docker Compose.
2. Canonical model: Zod schemas + Prisma schema in `shared/canonical` and `backend/src/prisma/`. No business logic yet.
3. Working-day calendar module with tests.
4. LWCA + Rentancy integration clients with the refresh-token auth flow. Read-only. Mock first via fixtures, then point at stage.
5. Case lifecycle: open/close on overdue invoice detection. Polling job.
6. Chase cadence engine with daily digest delivery, drafting to review queue (no send yet).
7. Outlook inbound polling + deterministic pre-filter + Claude classification + draft replies into review queue.
8. Frontend: cases list, case detail (timeline), review queue, organisation config screen.
9. Outbound send path, gated on review queue approval, with Mailhog locally.
10. Promise workflow.
11. Partial payment chase-stage logic.
12. S8 threshold notification.
13. Breathing space (manual toggle + email-triggered detection routed through pre-filter).
14. Guarantor parallel track.

Items 10–14 are post-MVP for the local POC. Items 1–9 are the demo slice. See `docs/poc-scope.md` for acceptance criteria.

## What this is not

- Not a compliance checker. The system assumes the agent has handled prescribed information requirements and upstream legal obligations correctly. Don't add features that purport to validate compliance.
- Not a replacement for human judgement on edge cases. Anything not matched by an explicit rule escalates.
- Not a generic CRM. It does one thing: arrears chasing.

## Open items (TBC, do not block on)

- AWS account allocation for hosted POC — use placeholder ARNs in IaC until allocated.
- Cognito service user provisioning for LWCA + Rentancy stage — until provisioned, run against fixtures via `INTEGRATION_MODE=fixtures` (default in dev).
- Production model for Anthropic billing — POC uses a dev API key with strict spend cap.
- **Mail integration mode for demos: Gmail/IMAP+SMTP (`OUTBOUND_MODE=gmail`, `INBOUND_MODE=gmail`)** is the live path. Verified end-to-end against `alanadam169@gmail.com` (Adam's Google account, App Password): inbound polled, sender-matched, drafts approved, outbound delivered to external recipients (`adam.balazinski+…@lofty.com`). Sits side-by-side with the Outlook code path — neither set of work is lost. Switch via `OUTBOUND_MODE` + `INBOUND_MODE` env (also affects which connection card on the org config page is consulted).
- **Outlook live integration paused on a real tenant.** Code is verified by unit tests (52 inbound tests pass) and by direct OAuth round-trip against `MindLab168.onmicrosoft.com`. Two separate blockers were hit and only the first is fixed:
  - *Bootstrap*: fresh M365 Business Basic trial tenants enable RBAC-for-Apps by default, and even a Global Admin can't self-grant delegation on the new `Application Mail.ReadWrite` / `Application Mail.Send` roles (`New-ManagementRoleAssignment -App …` returns "you must be assigned a delegating role assignment"). Application Access Policy + `Test-ApplicationAccessPolicy: Granted` is ignored because RBAC for Apps overrides legacy AppAccessPolicy. **Worked around** by switching the Graph client to delegated OAuth (user signs in once, refresh token stored encrypted; bypasses the RBAC-for-Apps gate entirely).
  - *Outbound spam policy*: even after delegated OAuth was working, Microsoft's outbound spam reputation system refuses to relay Graph `sendMail` traffic from this trial tenant (`550 5.7.708 AS(7230)`). Reputation-based, not code-based — established M365 tenants don't hit this. **Not fixable in code**; either delist via support ticket, wait for the tenant to "warm up", or run on a real customer tenant.
  - Resume Outlook live verification when running against Lofty's actual production tenant — their IT team will own the bootstrap AND the established tenant has sender reputation, so neither blocker applies. The delegated OAuth path stays available; production code can flip back to application-creds via `OUTLOOK_AUTH=app` once RBAC is configured. See `docs/integrations.md § Setting it up against live Outlook` for the full operational checklist.

## Code review checklist

Before opening a PR:

- [ ] All hard rules above respected
- [ ] New canonical fields have mappers from every upstream source
- [ ] New rules have a corresponding entry in `docs/business-rules.md` and a test
- [ ] No money as `number`, no balance caching, no prod URLs
- [ ] All queries scoped by `organisationId`
- [ ] Outbound send path still routed via review queue
