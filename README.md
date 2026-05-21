# Arrears POC

Arrears chasing application for UK lettings agents. Local proof of concept against the LWCA staging environment.

For everything — what this is, conventions, hard rules, build approach — see [CLAUDE.md](./CLAUDE.md) and the docs under [`docs/`](./docs).

## Quick start

```bash
# 1. Install deps
pnpm install

# 2. Bring up Postgres + Mailhog
docker compose up -d postgres mailhog

# 3. Configure backend env
cp backend/.env.example backend/.env
# Generate the local credential-store key (AES-256-GCM, required for boot):
KEY=$(openssl rand -base64 32)
sed -i "" "s|^CREDENTIAL_ENCRYPTION_KEY=.*|CREDENTIAL_ENCRYPTION_KEY=$KEY|" backend/.env
# Skip Cognito locally — any non-empty value bypasses JWT verification:
echo 'DEV_AUTH_BYPASS_USER_ID=demo-user' >> backend/.env

# 4. Migrate + seed the demo org
pnpm --filter backend prisma:migrate:dev
pnpm --filter backend seed

# 5. Run everything (backend + frontend in parallel)
pnpm dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:3001
- Mailhog UI: http://localhost:8025

Defaults run in **fixtures mode** (`INTEGRATION_MODE=fixtures`). No real LWCA / Rentancy / Outlook credentials needed — upstream payloads come from `fixtures/`.

## First demo run

With the stack up, set the org id you'll be working against:

```bash
export ORG_ID=demo-org             # fixtures mode (matches the seeded fixture data)
# export ORG_ID=<your-workspace>    # stage mode — any Rentancy workspace id you have access to
```

Then:

1. Open http://localhost:5173 and pick the org. In fixtures mode it's the seeded `Demo Lettings Ltd`; in stage mode, create it with `id = $ORG_ID` if it doesn't exist.
2. Add upstream credentials via the org page. Fixtures: any non-empty string is accepted. Stage: paste your Cognito **ID token** (the JWT with the `custom:userId` claim — not the access token).
3. Trigger a poll:
   ```bash
   curl -X POST http://localhost:3001/dev/force-sync/$ORG_ID
   ```
4. Cases appear under the org. Seed inbound emails onto a case to populate the review queue:
   ```bash
   # Seed one fixture
   curl -X POST http://localhost:3001/dev/seed-fixture-emails/<caseId> \
     -H 'Content-Type: application/json' \
     -d '{"fixture":"inbound-hardship.eml"}'
   ```

For real stage credentials, see [`docs/auth-and-credentials.md`](./docs/auth-and-credentials.md). For demo scenarios, see [`docs/poc-scope.md`](./docs/poc-scope.md). For a stakeholder demo walkthrough, see [`docs/demo-script.md`](./docs/demo-script.md).

## Business rule that surprises everyone: rent-only

The chase pipeline operates on **rent** invoices only — deposits, council tax, utilities, etc. are filtered out at the LWCA mapper (`LwcaInvoiceMapper.isArrearsCandidate`). We tried pushing the filter upstream via `?lineItemType=Rent` on the LWCA query but stage silently ignores it. So:

- The HTTP client hydrates each invoice summary with `GET /v1/api/invoice/{id}` to pick up `lineItems[]`, then drops any invoice whose line items don't include `type === "Rent"`.
- N+1 requests, capped at 5 in flight (`HYDRATE_CONCURRENCY`).
- Pre-existing non-rent rows in the DB are cleaned via `POST /dev/purge-non-rent/:orgId`.

See [`docs/business-rules.md`](./docs/business-rules.md) and [`docs/integrations.md`](./docs/integrations.md) for the details.

## Running tests

```bash
pnpm test                            # whole workspace
pnpm --filter backend test           # backend only
pnpm --filter backend exec vitest run -t "rent-only smoke"   # a single rule, by name
```

Tests run against a **dedicated `arrears_poc_test` database** on the same Postgres instance. A Vitest globalSetup (`backend/test-setup/global-setup.ts`) creates the DB if missing, runs `prisma migrate deploy`, and re-points `DATABASE_URL` for the run. `pnpm dev` keeps using `arrears_poc` and won't be touched by the suite.

To reset the test DB explicitly (rare — useful if migrations get into a bad state):

```bash
DATABASE_URL=postgres://arrears:arrears@localhost:5432/arrears_poc_test \
  pnpm --filter backend exec prisma migrate reset --force --skip-seed
```

## Dev endpoints

Behind `DEV_TOOLS_ENABLED=true` in `backend/.env` (default). All require an auth token; locally `DEV_AUTH_BYPASS_USER_ID` short-circuits the JWT check.

| Endpoint                                        | Purpose                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `POST /dev/force-sync/:orgId`                   | Run LWCA poll inline — pulls invoices + opens/closes cases now          |
| `POST /dev/reset-demo/:orgId`                   | Wipe org's per-case derived state (cases, charges, comms, events…) then re-sync. Keeps creds + config + contacts + tenancies. Also wired to the **Reset demo** button on the cases list. |
| `POST /dev/purge-non-rent/:orgId`               | One-shot cleanup of historical non-rent Charge rows                     |
| `GET  /dev/inspect-lwca/:orgId`                 | Dump the raw LWCA arrears list + per-invoice line items for debugging   |
| `POST /dev/run-inbound-poll`                    | Run the Outlook inbound poll inline (skip the 5-min cron)               |
| `POST /dev/run-promise-expiry`                  | Run the promise-expiry job inline (skip the 09:00 cron)                 |
| `GET  /dev/clock`                               | Show the current Clock offset                                           |
| `POST /dev/advance-clock`                       | `{"workingDays":N}` — bump clock + run chase tick + run digest inline   |
| `POST /dev/reset-clock`                         | Reset Clock offset to zero                                              |
| `GET  /dev/fixture-emails`                      | List `.eml` fixture filenames available to seed                         |
| `POST /dev/seed-fixture-emails/:caseId`         | Drop one or all fixture emails onto a case + run inbound pipeline       |

## Live upstreams

- **LWCA + Rentancy:** stage hosts are pinned at the env level (`LWCA_STAGE_BASE_URL`, `RENTANCY_STAGE_BASE_URL`). Production URLs are blocked by [hard rule #1](./CLAUDE.md#hard-rules--non-negotiable). Per-org Cognito tokens are stored encrypted on the credential-store row.
- **Anthropic:** off by default (`ANTHROPIC_MODE=disabled`). Set `ANTHROPIC_MODE=live` plus an `ANTHROPIC_API_KEY` to call Claude live. Recommended pattern: `read -rs ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY` in the same terminal as `pnpm dev`, so the key never lands on disk or in any file change that might mirror to chat.
- **Outlook:** Mailhog by default. Switch to real Microsoft Graph by setting `OUTBOUND_MODE=outlook` and `INBOUND_MODE=outlook`, plus the four `OUTLOOK_*` env vars. Full Azure AD + shared-mailbox setup is in [`docs/integrations.md § Setting it up against live Outlook`](./docs/integrations.md).

## Regenerating the frontend API types

When you change a backend response shape that's annotated with `@ApiOkResponse(...)`:

```bash
pnpm --filter backend openapi:export      # writes backend/openapi.json
pnpm --filter frontend openapi:generate   # writes frontend/src/lib/openapi.d.ts
```

`tsc --noEmit` in the frontend will then surface any callers that need updating. Swagger UI is mounted at http://localhost:3001/api-docs while the backend is running in dev mode. Not every controller is fully annotated yet — endpoints that aren't show up in the spec without typed responses; expand by adding `@ApiOkResponse({ type: ... })` to the controller method.

## CI

GitHub Actions runs typecheck + lint + test (against Postgres) + build on every push to `main` and every PR. See [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).
