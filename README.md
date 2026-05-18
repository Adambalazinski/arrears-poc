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

With the stack up:

1. Open http://localhost:5173 and pick the seeded `demo-org` ("Demo Lettings Ltd").
2. Add upstream credentials via the org page — in fixtures mode any non-empty string is accepted.
3. Trigger a poll:
   ```bash
   curl -X POST http://localhost:3001/dev/force-sync/demo-org
   ```
4. Cases appear under the org. Seed inbound emails onto a case to populate the review queue:
   ```bash
   # Seed all fixture emails
   curl -X POST http://localhost:3001/dev/seed-fixture-emails/<caseId>
   # ...or just one
   curl -X POST http://localhost:3001/dev/seed-fixture-emails/<caseId> \
     -H 'Content-Type: application/json' \
     -d '{"fixture":"inbound-hardship.eml"}'
   ```

For real stage credentials, see [`docs/auth-and-credentials.md`](./docs/auth-and-credentials.md). For demo scenarios, see [`docs/poc-scope.md`](./docs/poc-scope.md).
