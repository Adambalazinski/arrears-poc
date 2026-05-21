# Integrations

Single doc covering all four external systems Arrears touches in POC: LWCA Accounting API, Rentancy API, Microsoft Graph (Outlook), and Anthropic API. Each section is endpoints + auth + how we map into the canonical model.

For cross-cutting credential lifecycle (refresh-token mechanics, encryption), see `docs/auth-and-credentials.md`.

## 1. LWCA — Accounting API

Spring Boot monolith. Stage URL: `https://loftyworks-accounting.stage.pay.loftyworks.com`. OAuth2/Cognito JWT bearer (the **ID token**, not the access token — see "Authentication" below).

We deliberately do **not** call the `arrears` endpoint LWCA exposes. We derive arrears from the invoice endpoint so the rule for "what counts as arrears" lives entirely in Arrears and is identical across Phase 2 sources.

### Endpoints used

| Method | Path                            | When                                                                       |
| ------ | ------------------------------- | -------------------------------------------------------------------------- |
| GET    | `/v1/api/invoice`               | Polling — list invoices in arrears states for a configured organisation     |
| GET    | `/v1/api/invoice` (probe)       | Credential setup — `limit=1` call to validate the JWT works                 |
| GET    | `/v1/api/invoice/{id}/lineitems`| On demand — when reviewer opens a case detail page (used to enrich display) |

### Listing arrears

```
GET /v1/api/invoice
  ?type=OUTBOUND
  &isArrear=true
  &statuses=UNPAID,PARTIALLY_PAID,PARTIALLY_RECONCILED
  &page=1
  &size=100
  &sort=due_date,asc
Headers:
  Authorization: Bearer <id_token>
```

`isArrear=true` on LWCA's side is the same condition we'd apply anyway: `remainAmount > 0 AND paymentCycleType != RECURRING`. We send it because it shrinks the page; we still re-verify on our side so a future change in LWCA semantics doesn't silently break our rule.

`type=OUTBOUND` selects invoices the agency raises *outward* to tenants (rent and tenant charges). The naming is the agency's POV: "outbound" = "owed to us". INBOUND = bills the agency receives from landlords/contractors, irrelevant to tenant arrears chasing. (The Lofty stage UI uses the same `type=OUTBOUND` filter for its arrears view, which is how we confirmed the contract.)

Pagination is **1-indexed** on stage — `page=0` returns `400 Validation failed: page: must be greater than or equal to 1`.

Response is the paginated `PagedResponse<InvoiceApiResponse>` defined in `loftyworks-accounting/src/main/java/com/moatable/loftyworks/accounting/invoice/api/response/InvoiceApiResponse.java`. Shape we care about, per item:

```json
{
  "id": "1e8f...",                  // → Charge.lwcaInvoiceId
  "organisationId": "...",
  "referenceId": "INV-12345",
  "grossAmount": 120000,            // pence, BigInteger → Charge.grossAmountPence
  "remainAmount": 80000,            // pence → Charge.lastKnownRemainAmountPence
  "dueDate": "2025-04-01",          // ISO date → Charge.dueDate
  "invoiceDate": "2025-03-15",
  "status": "PARTIALLY_PAID",       // → Charge.lastKnownStatus
  "paymentCycleType": "MONTHLY",    // → Charge.lastKnownPaymentCycleType (RECURRING gets filtered out)
  "property": {                     // → denormalised onto Tenancy when refreshed
    "propertyId": "...",
    "propertyName": "Flat 2, ...",
    "propertyAddress1": "12 High Street",
    "propertyAddress2": "London"
  },
  "payer": {                        // tenant
    "payerId": "...",               // we don't store this directly — Rentancy contactId is source of truth
    "firstName": "Jane",
    "lastName": "Tenant"
  },
  "tenancyId": "...",               // → Charge.case.tenancyId (after we open/find the case)
  "type": "RENT",
  "payeeType": "LANDLORD"
}
```

### Refreshing a single invoice (for live-balance checks)

```
GET /v1/api/invoice?type=INBOUND&propertyIds=<id>&statuses=UNPAID,PARTIALLY_PAID,PARTIALLY_RECONCILED,PAID,RECONCILED&size=200
```

There is no `GET /v1/api/invoice/{id}` for a single invoice fetch in the controller we read. To refresh one invoice's balance we either:

1. Re-list with a tight filter (cheap, works), or
2. Cache an in-memory result for a short TTL (e.g. 30 seconds) when multiple rules ask for the same invoice during one approval action

POC: option 1, no caching. If perf hurts we add the TTL cache. The "no caching" rule applies to *persistence*, not to a request-scoped value held in memory for the duration of one action.

### Mapping → canonical

| LWCA field                         | Canonical destination                                |
| ---------------------------------- | ---------------------------------------------------- |
| `invoice.id`                       | `Charge.lwcaInvoiceId` (unique)                      |
| `invoice.organisationId`           | `Charge.organisationId`                              |
| `invoice.grossAmount`              | `Charge.grossAmountPence`                            |
| `invoice.remainAmount`             | `Charge.lastKnownRemainAmountPence`                  |
| `invoice.dueDate`                  | `Charge.dueDate`                                     |
| `invoice.invoiceDate`              | `Charge.invoiceDate`                                 |
| `invoice.status`                   | `Charge.lastKnownStatus`                             |
| `invoice.paymentCycleType`         | `Charge.lastKnownPaymentCycleType` (filter RECURRING)|
| `invoice.tenancyId`                | `Case.tenancyId` (case lookup or open)               |
| `invoice.property.*`               | `Tenancy.property*` (denormalised on refresh)        |

Mapper: `backend/src/integrations/lwca/lwca-invoice.mapper.ts`. Exports `toCanonicalCharge(invoice, orgId)`. Tested with full LWCA fixture in `fixtures/lwca/invoices-list.json`.

### Stage shape divergences (May 2026)

The LWCA stage HTTP response diverges from the canonical envelope the fixture uses. `backend/src/integrations/lwca/lwca-stage-shape.ts` normalises before Zod parsing so a single schema handles both paths.

| Wire field (stage)   | Canonical field          | Notes |
| -------------------- | ------------------------ | --- |
| `returnList[]`       | `content[]`              | Page envelope key |
| `page`               | `number`                 | Same value, different key |
| `totalItems`         | `totalElements`          | Page envelope key |
| `tenancy.id`         | `tenancyId` (row-level)  | Top-level `tenancyId` is always null on stage — the real id sits nested under `tenancy: { id, reference, balance }` |

Tenancy-less invoices (where neither `tenancyId` nor `tenancy.id` resolves to a string) are dropped by the mapper: the chase pipeline is keyed on tenancies, so there's nothing actionable to do with an unallocated charge. Stage exposes a fair number of these — they're unallocated/ad-hoc charges from the agency's ledger.



### Filtering rule on read

After receiving the response, the mapper applies these on the Arrears side regardless of what LWCA returned:

```
ignore if status == DELETED
ignore if paymentCycleType == RECURRING        // recurring templates, not actual charges
ignore if remainAmount <= 0                    // no outstanding balance
ignore if dueDate is null                      // shouldn't happen, but be safe
```

Anything passing these is a real arrear we own a case for.

### Authentication

Cognito-issued JWT in `Authorization: Bearer ...`. Token belongs to a service user on Lofty's stage Cognito pool, scoped to the organisation being polled. Refresh handled per `docs/auth-and-credentials.md`.

### Errors

| Code   | Meaning                              | Arrears response                                                |
| ------ | ------------------------------------ | --------------------------------------------------------------- |
| 401    | Token invalid or expired             | One forced refresh + retry; on second 401 → `CREDENTIALS_EXPIRED` flag, halt polling for that org |
| 403    | Token valid but no access to org     | Mark credential row stale; surface in UI as "credential lacks access"; halt polling |
| 404    | Org not found                        | Mark credential row stale; halt polling                          |
| 429    | Rate limited                         | Exponential backoff inside the polling job; not propagated as user error |
| 5xx    | LWCA down                            | `SyncJobRun.status = FAILED`; next tick retries; no user alert   |

Backoff schedule for 429 / 5xx: 1s, 4s, 16s, then give up this tick.

## 2. Rentancy API

Lambda + DynamoDB. Stage URL: `https://rentancy-api.stage.pay.loftyworks.com`. Same Cognito user pool as LWCA (confirmed via probe).

### Endpoints used

| Method | Path                                                                              | When                                              |
| ------ | --------------------------------------------------------------------------------- | ------------------------------------------------- |
| GET    | `/v2/organisations/{organisationId}/tenancies/{tenancyId}`                        | When opening a new case; periodic refresh        |
| GET    | `/v2/organisations/{organisationId}/contacts/{contactId}`                         | After getting tenancy, for tenants + guarantors  |
| GET    | `/v2/organisations/{organisationId}/tenancies?limit=1`                            | Credential probe                                  |

### Fetching tenancy

Shape from `rentancy-api/src/v2/tenancies/`:

```json
{
  "id": "...",
  "tenancyPropertyId": "...",
  "status": "ACTIVE",                  // → Tenancy.status (mapped to ACTIVE/ENDED/UNKNOWN)
  "reference": "TN-2024-...",
  "paymentDay": 1,                     // → Tenancy.rentDayOfMonth
  "tenants": ["contactId1", "contactId2"],     // → TenancyContact rows with role=TENANT
  "guarantorIds": ["contactId3"],              // → TenancyContact rows with role=GUARANTOR
  "isRentGuaranteeRequired": false,
  "askingPrice": 120000,
  "agreedPrice": 120000,               // → Tenancy.rentAmountPence (informational only)
  "additionalCosts": [],
  "startDate": "2024-09-01",
  "endDate": null
}
```

Both `guarantorIds` and `guarantors` fields appear in the schema (legacy + canonical). The mapper reads `guarantorIds ?? guarantors ?? []` and dedupes.

### Fetching contact

Shape from `rentancy-api/src/v2/contacts/`:

```json
{
  "id": "...",
  "fname": "Jane",                   // → Contact.firstName
  "sname": "Tenant",                 // → Contact.lastName
  "companyName": null,
  "emails": [
    { "type": "PERSONAL", "email": "jane@example.com" },   // first one → Contact.primaryEmail
    { "type": "WORK", "email": "j.tenant@work.co.uk" }
  ],
  "phones": [
    { "type": "MOBILE", "phone": "+447700900000" }
  ]
}
```

`primaryEmail` policy: first email in the array. If we later want a marked-as-primary flag, we add it here, not in `Contact`.

### Mapping → canonical

| Rentancy field                          | Canonical destination                           |
| --------------------------------------- | ----------------------------------------------- |
| `tenancy.id`                            | `Tenancy.id`                                    |
| `tenancy.paymentDay`                    | `Tenancy.rentDayOfMonth`                        |
| `tenancy.agreedPrice`                   | `Tenancy.rentAmountPence`                       |
| `tenancy.status`                        | `Tenancy.status` (uppercase, mapped)            |
| `tenancy.tenants[]`                     | `TenancyContact` rows, role=`TENANT`            |
| `tenancy.guarantorIds[] ?? guarantors[]`| `TenancyContact` rows, role=`GUARANTOR`         |
| `contact.fname`                         | `Contact.firstName`                             |
| `contact.sname`                         | `Contact.lastName`                              |
| `contact.emails[0].email`               | `Contact.primaryEmail`                          |
| `contact.emails`                        | `Contact.emailsJson` (verbatim)                 |
| `contact.phones`                        | `Contact.phonesJson` (verbatim)                 |

### Stage shape divergences (May 2026)

Rentancy stage diverges from the canonical schema in two ways. `backend/src/integrations/rentancy/rentancy-stage-shape.ts` normalises before parsing.

| Wire field (stage)                                  | Canonical field        | Notes |
| --------------------------------------------------- | ---------------------- | --- |
| `tenancy.tenants[]: { tenantId, primary }`          | `tenants: string[]`    | Stage returns tenant objects; the adapter extracts the `tenantId`. `guarantorIds` / `guarantors` follow the same shape (looks for `id`, `tenantId`, `guarantorId`, `contactId`). |
| `contact.firstName` / `contact.lastName`            | `fname` / `sname`      | Stage uses camelCase; canonical and the fixture use the shorter form. |


Property details come from LWCA's `invoice.property` block, not from Rentancy. Both repos have property concepts; LWCA's is sufficient for our display needs.

### When we fetch

- **On case open:** one fetch of the tenancy + one fetch per contact in `tenants` and `guarantorIds`. Persisted.
- **`RentancyTenancyRefreshJob` (hourly):** for every tenancy with an active case, re-fetch tenancy + all contacts. Cheap, ensures contact email changes pick up.
- **On reviewer "refresh" button** on case detail: same as above, on demand.

### Authentication

Same JWT as LWCA. Working assumption: identical token works on both APIs because they share the Cognito pool.

If they don't (TBC), the `OrganisationCredential` row gains a second token pair and `withFreshAccessToken(orgId, target)` takes a `target: 'lwca' | 'rentancy'` argument. We'll know at first probe.

### Errors

Same handling as LWCA except 404 on a specific tenancy/contact: log, mark missing on the case, do not halt polling. Tenants leave, tenancies get deleted; this is expected.

## 3. Microsoft Graph — Outlook

Single shared mailbox serves all configured organisations in POC. App-level credentials (no per-organisation tokens).

### Permissions required

- `Mail.Read` — list and read messages from the shared mailbox
- `Mail.Send` — send as the shared mailbox
- `Mail.ReadWrite` — mark messages read, move to "Processed" folder

All scoped via `ApplicationAccessPolicy` to the one shared mailbox UPN. Granted by an Azure AD admin once during setup. After that, the app runs with client credentials (no user sign-in).

### Endpoints used

| Method | Path                                                                                       | When                          |
| ------ | ------------------------------------------------------------------------------------------ | ----------------------------- |
| GET    | `/v1.0/users/{mailbox}/mailFolders/Inbox/messages?$filter=receivedDateTime ge {since}&$top=50&$orderby=receivedDateTime asc` | Inbound poll (every 5 min) |
| GET    | `/v1.0/users/{mailbox}/messages/{id}`                                                       | Fetch full body for processing |
| POST   | `/v1.0/users/{mailbox}/sendMail`                                                            | Approved outbound             |
| POST   | `/v1.0/users/{mailbox}/messages/{id}/move`                                                  | Move to "Processed" after ingestion |
| PATCH  | `/v1.0/users/{mailbox}/messages/{id}` `{ isRead: true }`                                   | Mark as read on ingestion     |

### Inbound polling

Poll every 5 minutes. Cursor is the most recent `receivedDateTime` we successfully ingested, persisted on `SyncJobRun` and on a singleton `outlook_poll_cursor` row.

```
1. since = max(cursor - 2 min overlap, now - 24h)
2. list messages with receivedDateTime ≥ since
3. for each message (oldest first):
     idempotency: skip if outlookMessageId already exists in Communication
     fetch full body (bodyPreview is truncated; we need full)
     match sender email → Contact (organisationId-aware lookup on primaryEmail; fallback secondary emails)
     route to InboundPipeline (see architecture.md flow 3)
     mark as read; move to "Processed" subfolder
4. advance cursor to max receivedDateTime processed
```

2-minute overlap is to handle Graph's eventual consistency — messages sometimes appear after their `receivedDateTime` has passed. Idempotency on `outlookMessageId` makes the overlap free of side effects.

### Sender matching

```
1. normalise sender email (lowercase, strip plus-addressing)
2. lookup Contact by (organisationId, primaryEmail) — but we don't know orgId yet
   ⇒ lookup across all Contact rows where primaryEmail matches
3. if exactly one match: route to that org/case
4. if multiple matches across organisations: log "ambiguous sender", do not route, surface on a "needs triage" admin page
5. if no primary-email match: search emailsJson for a secondary match; same logic
6. if no match anywhere: mark Communication as orphan with the raw sender stored, do not link to a case
```

For POC the "needs triage" page can be a simple list. Ambiguous senders are expected to be rare with the small scope.

### Outbound send

Triggered by review queue approval. Body is HTML (rendered from Markdown via `marked`). Plain-text fallback auto-generated.

```json
{
  "message": {
    "subject": "Reminder: rent payment overdue — total £2,400 outstanding",
    "body": { "contentType": "HTML", "content": "<p>Dear Jane,...</p>" },
    "toRecipients": [{ "emailAddress": { "address": "jane@example.com" } }]
  },
  "saveToSentItems": true
}
```

`saveToSentItems: true` so handlers can see what went out in the shared mailbox's Sent folder, not just in our DB.

### Authentication

Microsoft Graph SDK with client credentials (`@azure/identity` `ClientSecretCredential`). Tokens cached by the SDK; we don't manage refresh.

Env / Secrets Manager:

- `OUTLOOK_TENANT_ID`
- `OUTLOOK_CLIENT_ID`
- `OUTLOOK_CLIENT_SECRET`
- `OUTLOOK_SHARED_MAILBOX` — UPN like `arrears-test@<lofty-tenant>.com`

### Local mode — Mailhog

When `OUTBOUND_MODE=mailhog`:

- Inbound polling still goes against real Graph (or `INTEGRATION_MODE=fixtures` to use seeded fixtures)
- Outbound send goes through nodemailer SMTP to `localhost:1025`
- Mailhog UI at `localhost:8025` shows captured messages

When `OUTBOUND_MODE=outlook`: real send via Graph. Used only when intentionally testing the send path.

### Setting it up against live Outlook

One-time work by a Microsoft 365 tenant admin (Lofty IT). The codebase is already wired; this section is the operational checklist.

> **Heads-up: personal `outlook.com` / `hotmail.com` / `live.com` mailboxes will not work.** The integration uses Graph **application credentials** (`ClientSecretCredential`), which only work against mailboxes in an Entra ID tenant. Personal Microsoft accounts live in the consumer cloud — no tenant ID, no admin consent, no Application Access Policy. If you don't already have an M365 tenant, see the quick-start immediately below.

#### Quick-start: free Microsoft 365 Developer tenant

For dev / demo work with no existing M365 subscription. Production should target the real Lofty tenant; this path is for evaluating the integration end-to-end at zero cost.

1. **Sign up.** https://developer.microsoft.com/microsoft-365/dev-program → **Join**. Free, signed-in with any Microsoft account (the dev-program identity is separate from the tenant it provisions). Pick an immediate setup, not the deferred / configurable one.

2. **Provision a sandbox tenant.** During signup you choose:

   - **Instant sandbox** (recommended): pre-populated with ~25 fake users, Teams data, SharePoint sites — handy if you want to test sender-matching against multiple Contacts later.
   - **Configurable sandbox**: empty tenant; you create users yourself.

   Pick a tenant prefix (becomes `<prefix>.onmicrosoft.com`) and an admin username + password. Save both — there's no recovery.

3. **Wait for provisioning.** Usually 1–5 minutes. The dashboard shows when the tenant is ready and surfaces the admin UPN (e.g. `admin@<prefix>.onmicrosoft.com`) and the tenant domain.

4. **Sign in to the admin centre.** https://admin.microsoft.com using the admin UPN. You're now in your own M365 tenant with full admin rights. From here on, follow the main setup below.

5. **Renewal.** Developer tenants expire 90 days after the last "qualifying activity" — keep one of these on a recurring reminder: sign into the admin centre, send a Graph API call against the tenant, or use a Visual Studio Code extension that exercises it. Otherwise the tenant deletes (no recovery) and you'll need to start over.

The rest of the setup steps below work identically against a Developer tenant and against Lofty's production tenant — only the values change.

#### Main setup

1. **Provision a shared mailbox.** In Exchange admin centre, create a new shared mailbox (e.g. `arrears-test@<tenant>.onmicrosoft.com`). Note the UPN — this is `OUTLOOK_SHARED_MAILBOX`. Don't add user licences; shared mailboxes don't need them.

2. **Register an Azure AD application.** Entra admin centre → App registrations → New registration. Single-tenant. No redirect URI (we use client credentials, not OAuth user flow). Note the **Application (client) ID** (→ `OUTLOOK_CLIENT_ID`) and the **Directory (tenant) ID** (→ `OUTLOOK_TENANT_ID`).

3. **Grant Microsoft Graph application permissions.** On the app's API permissions page, add three Microsoft Graph **Application** permissions (not Delegated):

   - `Mail.Send` — send as the shared mailbox
   - `Mail.ReadWrite` — list inbox, read full body, mark as read
   - (`Mail.Read` is implied by `Mail.ReadWrite`; no need to add separately)

   Click **Grant admin consent** after adding. The status column should turn green.

4. **Scope the app to one mailbox via Application Access Policy.** Without this, the app could read/send for every mailbox in the tenant. Run from PowerShell (Exchange Online module, admin):

   ```powershell
   New-ApplicationAccessPolicy `
     -AppId "<OUTLOOK_CLIENT_ID>" `
     -PolicyScopeGroupId "arrears-test@<tenant>.onmicrosoft.com" `
     -AccessRight RestrictAccess `
     -Description "Arrears app — scoped to the arrears shared mailbox only"
   ```

   Verify with `Test-ApplicationAccessPolicy -Identity <mailbox-upn> -AppId <client-id>` — `AccessCheckResult` must be `Granted`.

5. **Create a client secret.** App → Certificates & secrets → New client secret. Copy the **Value** immediately (it's only shown once). This is `OUTLOOK_CLIENT_SECRET`. Set a sensible expiry; rotate before it lapses.

6. **Set env vars.** In `backend/.env` (or AWS Secrets Manager hosted-side):

   ```ini
   OUTLOOK_TENANT_ID=<from step 2>
   OUTLOOK_CLIENT_ID=<from step 2>
   OUTLOOK_CLIENT_SECRET=<from step 5>
   OUTLOOK_SHARED_MAILBOX=arrears-test@<tenant>.onmicrosoft.com
   OUTBOUND_MODE=outlook
   INBOUND_MODE=outlook
   ```

7. **Smoke test inbound.** Send a test email from any user account to the shared mailbox. Wait up to 5 minutes for the next cron tick, or trigger inline:

   ```sh
   curl -X POST http://localhost:3001/dev/run-inbound-poll
   ```

   Expected response shape:

   ```json
   { "status": "COMPLETED", "processed": 1, "newCommunications": 1, ... }
   ```

   The message should appear under the matched case's Communications tab, and become read (no longer bold) in the shared inbox.

8. **Smoke test outbound.** Approve any outbound draft from the review queue. Confirm the message lands in the recipient's inbox and in the shared mailbox's **Sent Items** (`saveToSentItems: true`).

If `listInbound` errors with `Access denied`, the application access policy from step 4 hasn't been applied — `Test-ApplicationAccessPolicy` will say so. Policies propagate quickly (seconds) but caches can hold for ~30 min in some tenants.

## 4. Anthropic API

Direct via `@anthropic-ai/sdk`. Two model uses, both documented in detail in `docs/ai-decision-spec.md`. This section covers the integration mechanics only.

### Models in POC

- **Classification:** `claude-haiku-4-5` — fast and cheap, good enough for sentiment + intent on short tenant messages
- **Drafting:** `claude-sonnet-4-6` — better at tone matching and producing emails a human would actually approve

Model names live in `OrganisationConfig` so we can swap per-org without redeploying. Validated against an allowlist at request time.

### Client wrapper

`AnthropicClient` in `backend/src/integrations/anthropic/` is the only place `@anthropic-ai/sdk` is imported. Responsibilities:

1. Model name validation
2. Spend cap enforcement (read daily total from `classification_result.estimatedCostPence` aggregate, refuse new calls if over `ANTHROPIC_SPEND_CAP_GBP_DAILY`)
3. Pricing table for cost estimation per model
4. Logging (`prompt_tokens`, `completion_tokens`, `model`, `latencyMs`, `costPence`)
5. Retry on 429 / 5xx — 3 attempts with exponential backoff
6. PII redaction enforcement: refuses to send a prompt unless it passes through `Redactor.assertSafe(prompt)`

### Cost estimation

```
costPence =
  promptTokens * promptPricePencePerMillion / 1_000_000 +
  completionTokens * completionPricePencePerMillion / 1_000_000
```

Prices are configured per model in `backend/src/integrations/anthropic/pricing.ts`. Updated manually when Anthropic publishes new pricing. Verified against the latest published rates during initial setup.

### Errors

- Spend cap exceeded → typed error `AnthropicSpendCapExceeded`; inbound pipeline routes to `INBOUND_LOW_CONFIDENCE` review item with reason "spend cap exceeded"
- Rate limited → SDK handles with retry; if exhausted, same as above
- Model rejected output (content filter) → log full input, route to `INBOUND_LOW_CONFIDENCE`
- Network failure → 3 retries then route to `INBOUND_LOW_CONFIDENCE`

In every failure mode the inbound message still goes to the review queue. The AI is best-effort; the system never silently drops a message.

## 5. Probe contract for credential setup

When an admin saves credentials on the org config page, the system runs a probe to validate the JWT works before persisting. Probe is a no-side-effect operation against each upstream.

```ts
// backend/src/modules/organisations/credential-probe.service.ts
async function probe(orgId: string, accessToken: string): Promise<ProbeResult> {
  const results = await Promise.allSettled([
    lwcaInvoiceClient.probe(orgId, accessToken),       // GET /v1/api/invoice?limit=1
    rentancyTenancyClient.probe(orgId, accessToken),   // GET /v2/organisations/{orgId}/tenancies?limit=1
  ]);
  return {
    lwca: toStatus(results[0]),
    rentancy: toStatus(results[1]),
    overall: results.every(r => r.status === 'fulfilled' && r.value.ok) ? 'OK' : 'FAILED',
  };
}
```

UI surfaces both results side by side. Admin can save anyway if one fails (with a confirmation modal) — useful if e.g. Rentancy is temporarily down but they want to set up LWCA polling.

## 6. Fixtures

Every integration has a fixtures folder with representative payloads. Set `INTEGRATION_MODE=fixtures` and the integration clients read from disk instead of HTTP. Used by tests and by offline dev.

```
fixtures/
├── lwca/
│   ├── invoices-list-clean-tenancy.json
│   ├── invoices-list-early-arrears.json       (one charge at WD3-ish age)
│   ├── invoices-list-multi-charge.json         (multiple overdue charges, varying stages)
│   ├── invoices-list-s8-threshold.json         (balance ≥ 3 months' rent)
│   └── invoice-paid-after-draft.json           (balance changed since draft scenario)
├── rentancy/
│   ├── tenancy-no-guarantor.json
│   ├── tenancy-with-guarantor.json
│   ├── contact-tenant.json
│   ├── contact-guarantor.json
│   └── contact-multiple-emails.json
├── outlook/
│   ├── inbound-routine-promise.eml            ("I'll pay on Friday")
│   ├── inbound-payment-confirmed.eml
│   ├── inbound-query.eml
│   ├── inbound-hardship.eml                    ("lost my job")
│   ├── inbound-mental-health.eml               ("really struggling")
│   ├── inbound-breathing-space.eml             (debt advice / Debt Respite Scheme mention)
│   ├── inbound-third-party.eml                 (solicitor / Citizens Advice)
│   ├── inbound-dispute.eml                     ("I don't owe this")
│   ├── inbound-domestic.eml                    (bereavement language)
│   └── inbound-ambiguous-sender.eml            (sender matches multiple contacts)
└── anthropic/
    ├── classification-promise.json
    ├── classification-hardship.json            (asserts: never called when pre-filter hits)
    └── draft-reply-promise.json
```

The Outlook fixtures are raw `.eml` so they can be opened in any mail client to inspect, but they're consumed by tests as parsed JSON (subject, from, to, body).

## Open items (TBC)

These don't block build. Stubs and assumptions noted in code:

- Rentancy stage base URL — confirm with platform team
- Cognito pool sharing between LWCA and Rentancy — confirm; affects whether `OrganisationCredential` needs one or two token pairs
- Outlook shared mailbox UPN — provisioning underway
- Anthropic API key — using personal/dev key until billing assigned
