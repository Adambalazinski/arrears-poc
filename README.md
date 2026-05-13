# Arrears POC

Arrears chasing application for UK lettings agents. Local proof of concept against the LWCA staging environment.

For everything — what this is, conventions, hard rules, build approach — see [CLAUDE.md](./CLAUDE.md) and the docs under [`docs/`](./docs).

## Quick start

```bash
pnpm install
docker compose up -d postgres mailhog
pnpm --filter backend prisma:migrate:dev
pnpm dev
```

Frontend: http://localhost:5173 · Backend: http://localhost:3000 · Mailhog UI: http://localhost:8025
