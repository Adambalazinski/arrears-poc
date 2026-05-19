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

## Regenerating the frontend API types

When you change a backend response shape that's annotated with `@ApiOkResponse(...)`:

```bash
pnpm --filter backend openapi:export      # writes backend/openapi.json
pnpm --filter frontend openapi:generate   # writes frontend/src/lib/openapi.d.ts
```

`tsc --noEmit` in the frontend will then surface any callers that need updating. Swagger UI is mounted at http://localhost:3001/api-docs while the backend is running in dev mode. Not every controller is fully annotated yet — endpoints that aren't show up in the spec without typed responses; expand by adding `@ApiOkResponse({ type: ... })` to the controller method.
