# POC Scope

This document defines what's in and out of scope for the Arrears POC, in two stages: the **local POC** (developer laptop, against LWCA stage) and the **hosted POC** (AWS, internal demo audience). It is the source of truth when scope is contested — if a feature isn't listed here, it's out.

## Stage 1: Local POC

Goal: prove the architecture end-to-end on a narrow path. Demonstrate to internal stakeholders that the canonical-model + working-day-clock + review-queue spine works, and that AI classification + drafting is safe and useful.

### In scope

**Data ingestion**
- Pull invoices for one configured `organisationId` from LWCA stage (`GET /v1/api/invoice` with `isArrear=true`, statuses `UNPAID,PARTIALLY_PAID,PARTIALLY_RECONCILED`)
- Pull tenancy details from Rentancy API stage (`GET /v2/organisations/{orgId}/tenancies/{tenancyId}`)
- Pull contact details (tenant + guarantors) from Rentancy API stage (`GET /v2/organisations/{orgId}/contacts/{contactId}`)
- Map all of the above into canonical model
- Polling on a schedule (default: every 15 minutes) plus on-demand refresh via UI button

**Case lifecycle**
- Open a case when first qualifying overdue charge appears on a tenancy with no active case
- Bundle subsequent overdue charges on the same tenancy into the same active case
- Each charge runs its own per-charge working-day cadence (anchored to the charge's `dueDate`)
- Close the case when total case balance hits zero
- Closed cases remain visible (read-only) in case history
- Enforce one active case per tenancy with a partial unique index

**Chase cadence**
- Per-charge WD3 / WD5 / WD8 / WD14 events fired by a scheduled job
- Daily digest: one outbound message per case per day, consolidating all charge events that fired
- Most-severe tone wins when consolidating
- Email channel only (WhatsApp deferred)
- Drafts written into review queue with full per-charge breakdown and consolidated balance

**Inbound message handling**
- Poll shared Outlook mailbox via Microsoft Graph (`/users/{mailbox}/messages` filtered by received date)
- Match inbound messages to a case via sender email → tenant or guarantor contact
- Deterministic pre-filter runs first: regex/keyword classifier for hard escalation triggers (hardship, mental health, breathing space, third-party, dispute, domestic)
- Hard-trigger matches: route directly to handler, mark case for escalation, no Claude call
- Non-matches: Claude (Haiku) classifies sentiment + intent, drafts a reply (Sonnet), pushes to review queue
- Inbound message stored on the case timeline regardless of routing

**Review queue**
- Single list view of all drafted outbound communications and AI classifications awaiting decision
- Approve / edit / reject actions
- Approved messages send via Microsoft Graph (locally captured by Mailhog when `OUTBOUND_MODE=mailhog`)
- Rejection requires a reason (free text)

**Breathing space (manual)**
- Toggle on a case to put it in "breathing space" state
- Hard-stop: no further chase events fire on the tenant track for that case; existing queued drafts are auto-rejected with reason "breathing space active"
- Guarantor track continues (per BRD)
- Toggle off returns case to normal flow

**S8 threshold notification (case-level, no action)**
- When case balance ≥ 3 months' rent or 13 weeks' rent, surface a notification on the case
- When balance drops back below threshold, rescind the notification
- Notification is informational only; the system does not generate or send any S8 paperwork

**Frontend**
- Cases list (filter by status, organisation, severity)
- Case detail page with: header (tenant, property, balance, stage per charge), event timeline, charge list with per-charge stage and per-charge balance, communication thread, S8 indicator, breathing space toggle
- Review queue
- Organisation config screen (cadence overrides, templates, polling interval — see `docs/business-rules.md` for the parameter list)
- Manual "advance working-day clock" control (dev-only, behind `DEV_TOOLS_ENABLED=true`) for demo control

**Configuration per organisation**
- All thresholds, intervals, and templates configurable per `organisationId`
- Defaults match The Letting Partnership BRD
- Stored in DB, editable via UI, seeded for the demo organisation

**Auth**
- JWT against an Arrears-owned Cognito user pool (separate from LWCA's pool)
- Service-user refresh-token flow for outbound calls to LWCA + Rentancy stage (see `docs/auth.md`)
- Local dev: bypass with `DEV_AUTH_BYPASS_USER_ID=<uuid>` for fast iteration

**Observability**
- Structured logs (Pino, JSON)
- Health check endpoint
- Anthropic token cost logged per request (prompt + completion + total cost in £, computed from model pricing)

### Out of scope (Local POC)

- Promise workflow — deferred to post-MVP-1 slice
- Partial payment chase-stage step-back logic — deferred (initial implementation still surfaces partial payments on the timeline, but does not adjust stage)
- Guarantor parallel cadence track — deferred (guarantor contacts visible on case but no separate chases fired)
- WhatsApp channel
- Automated S8 paperwork generation
- Inbound channels other than email
- Bulk operations (mass approve, mass send)
- Custom rule editor — config is parameter overrides only, not arbitrary rules
- Reporting / analytics dashboards
- Webhooks back to LWCA
- Auto-send (master `ARREARS_AUTOSEND_ENABLED` exists but stays `false` for POC)
- Auth via LWCA's existing user pool (separate pool keeps blast radius small)
- Cross-case history evaluation (per design: case-scoped clean slate)
- Real production LWCA — stage only

### Acceptance criteria for Local POC

The local POC is "done" when a developer can, on a clean checkout:

1. `pnpm install && docker compose up -d && pnpm --filter backend seed` and have the demo organisation provisioned with seeded config and a service-user refresh token
2. `pnpm dev` starts API, frontend, and worker
3. Visit `http://localhost:5173`, log in as a dev user
4. Click "sync now" on the seeded organisation; cases appear pulled from LWCA stage with live balances from real stage invoices
5. Click "advance clock" to skip working days; observe chase events firing per-charge and consolidating into daily digest drafts in the review queue
6. Open a draft, see per-charge breakdown and consolidated balance in the body
7. Approve a draft; observe it arrive in Mailhog at `http://localhost:8025`
8. Send a test inbound email containing "I've lost my job" to the test mailbox; observe it route directly to handler escalation with no Claude call (verified in logs — zero Anthropic tokens consumed for that message)
9. Send a test inbound email containing a routine "I'll pay on Friday" message; observe Claude classification + drafted reply in the review queue
10. Toggle breathing space on a case; observe queued tenant drafts auto-rejected, no new chase events fire
11. All hard rules in `CLAUDE.md` verified by a checklist review against the build

### Demo scenarios to seed

Six pre-loaded test cases on stage (TBC: confirm availability with test-data team):

1. **Clean tenancy** — no arrears (sanity baseline)
2. **Early arrears** — one charge at WD3, no inbound, demonstrates first chase
3. **Multi-charge case** — two charges at different WD stages, demonstrates daily digest consolidation and most-severe tone
4. **S8 threshold** — balance ≥ 3 months' rent, demonstrates S8 indicator
5. **Hard-trigger inbound** — case with a "lost my job" inbound queued, demonstrates pre-filter escalation
6. **Tenant with guarantor** — guarantor contact visible on case (no parallel cadence yet, but data flow proven)

## Stage 2: Hosted POC

Goal: make Stage 1 available to a specific group of internal users over the internet for a longer-running, more representative trial. Same functional scope as Stage 1 plus the hosting and operability changes below. Still against LWCA **stage** environment, not production.

### Additionally in scope (Hosted POC)

- AWS ECS Fargate deployment of backend + worker (single task each, autoscale off for POC)
- Application Load Balancer with HTTPS via ACM
- RDS PostgreSQL (db.t4g.micro)
- Secrets Manager for Anthropic key, Microsoft Graph credentials, Cognito refresh tokens
- CloudWatch logs + a single CloudWatch dashboard with key metrics (cases open, drafts in queue, send success rate, API error rates)
- Cognito user pool for Arrears app (small group of internal users, manually invited)
- Domain + TLS via Route53 + ACM
- GitHub Actions CI/CD: lint, test, build, push to ECR, deploy to ECS
- Daily backups on RDS (7-day retention)
- A "kill switch" env var that immediately disables all outbound send (drafts continue to queue)
- Real shared Outlook mailbox (TBC: which mailbox, which Azure AD tenant)

### Still out of scope (Hosted POC)

Everything out of scope for Local POC, plus:

- Multi-region / DR
- Autoscaling
- Production LWCA
- External (non-Lofty-internal) users
- SLA commitments
- Pen testing / security audit (recommended before any non-internal use, but not in scope for this POC stage)

### Acceptance criteria for Hosted POC

The hosted POC is "done" when:

1. Internal users at the agreed email domain can sign in via Cognito at the production-like URL
2. The same demo scenarios from Stage 1 work against the hosted instance
3. A drafted message can be approved and sent to a real test mailbox; arrival verified
4. CloudWatch dashboard shows green health checks for 7 consecutive days
5. Anthropic cost stays under the agreed cap (TBC: stakeholder to set)
6. Stakeholder sign-off captured

## Out of scope across both stages — pinned

These are areas the team has discussed and explicitly chosen not to do in POC. Re-opening any of them needs a separate decision:

- Direct integration with PMS/CRM platforms other than LWCA + Rentancy. Phase 2 of the product will address this; POC does not preview it.
- Configurable rule engine (custom rule authoring in the UI). Configuration is limited to parameter overrides on a fixed rule set.
- AI explanation panel for case handlers ("why did the AI escalate this?"). Logged but not surfaced in UI.
- Cross-organisation comparison or benchmarking.
- Customer-facing portal for tenants.

## Open items

These do not block POC build, but must be resolved before the hosted POC goes live:

- AWS account allocation
- Cognito service user provisioning on Lofty's LWCA + Rentancy stage pool
- Azure AD shared mailbox + app registration with `Mail.Read` and `Mail.Send` scoped to that mailbox
- Anthropic spend cap and billing ownership
- Stakeholder list and approval workflow for hosted POC access
- Test data availability on LWCA stage matching the six demo scenarios above
