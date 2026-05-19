# Demo script — Arrears POC

Stakeholder-facing walkthrough of the six demo scenarios from [`poc-scope.md`](./poc-scope.md). Assumes the local stack is running per the [README](../README.md#quick-start).

Target audience for this doc: a new engineer running the demo for the first time. Target audience for the **demo itself**: someone non-technical who wants to see what the system does end-to-end.

Total runtime: ~10 minutes if you stick to the script, ~20 minutes with questions.

## Pick your data source

The script works against either upstream mode. **Pick one before you start** and set the org id you'll use throughout:

| Mode | When to use | `ORG_ID` value | Where the data comes from |
| --- | --- | --- | --- |
| **Fixtures** (`INTEGRATION_MODE=fixtures`, default) | Demo on a laptop with no Lofty access. The fixture data is curated so each scenario lands on a specific case. | `demo-org` (the fixture invoices are keyed on this id; don't change it) | `fixtures/lwca/invoices-list.json` + `fixtures/rentancy/*` |
| **Stage** (`INTEGRATION_MODE=stage`) | Demo with real Lofty stage data. Tenant names and balances reflect whatever's actually in the workspace. | Whatever Rentancy workspace id you have access to (visible in your ID token's `eligibleWorkspaces`) | LWCA + Rentancy stage APIs |

Export the choice as a shell variable so the rest of the commands pick it up:

```bash
export ORG_ID=demo-org             # fixtures
# export ORG_ID=<your workspace>    # stage
```

If you're running stage, also make sure credentials are saved and the cached ID token isn't expired — see "Stage mode preflight" at the bottom of this doc.

## Preflight (do this 5 minutes before showing up)

1. Confirm the stack is up:
   ```bash
   curl -s http://localhost:3001/health
   # {"status":"ok"}
   ```
2. Reset the demo state. In **fixtures mode** the seed creates the demo org and force-sync populates cases from disk:
   ```bash
   pnpm --filter backend seed
   curl -X POST http://localhost:3001/dev/force-sync/$ORG_ID
   ```
   Expected: `casesOpened` matches what's in the upstream. Fixtures → 3 cases. Stage → however many tenancy-linked arrears exist in your workspace.
3. Open http://localhost:5173 and click into the org. Cases visible.
4. Optional second tab: http://localhost:8025 — Mailhog. Empty inbox at this point. Useful if a question pulls the demo into the outbound side (approve a draft and show it landing here).

## Walkthrough

The six scenarios are ordered so the narrative builds — start with the boring case, end with the dramatic one.

**Fixtures-mode notes** below refer to the specific seeded data. In stage mode, find a case in your workspace that matches the scenario's shape.

### Scenario 1 — Clean tenancy (sanity baseline)

**Action:** Stay on the cases list. Point out that the list has only a handful of cases despite the upstream having more tenancies on the books.

**Talking points:**

> "We poll LWCA on a schedule and only open cases for tenancies with overdue charges. A tenant who pays on time never appears here. That's the sanity baseline — the system stays quiet when there's nothing to chase, which is most of the time."

### Scenario 2 — Early arrears

**Action:** Click into a case with a single small charge, recent due date, no chase history.

> Fixtures: `Sam Renter` / `tenancy-xyz-002`, £1,200 single charge.

**Talking points:**

> "Single charge, just past due. No chase history yet, no inbound from the tenant. This is what a first-touch case looks like — early enough that the right action is a polite first reminder, not legal threats."

### Scenario 3 — Multi-charge case

**Action:** Click into a case with multiple overdue charges on the same tenancy.

> Fixtures: `Jane Tenant` / `tenancy-abc-001`, two charges totalling £2,000.

**Talking points:**

> "Multiple overdue charges on one tenancy. Without consolidation we'd send two separate chase emails today. The daily digest job aggregates them into one draft, with both charges itemised in the body, and picks the template that matches the most-severe stage. The agent sees one item in the review queue, not two."

### Scenario 4 — Section 8 threshold

**Action:** Click into a case where the case detail shows the **S8 banner** (balance ≥ 3× monthly rent).

> Fixtures: `Priya Patel` / `tenancy-s8-001`, four unpaid charges totalling £4,800.

**Talking points:**

> "Balance is above the Section 8 threshold — three months' rent. The system flags the case; any drafts on it get bumped to URGENT priority in the review queue. We do not generate Section 8 paperwork — that's a legal step the agent handles in their own systems. The flag is purely informational and gives the agent an early signal."

> "If the tenant later pays enough to drop below the threshold, the flag clears automatically. If breathing space is active, the flag is suppressed entirely regardless of balance."

### Scenario 5 — Hard-trigger inbound

**Action:** Pick any active case and seed a hardship inbound onto it:

```bash
CASE_ID=$(curl -s http://localhost:3001/organisations/$ORG_ID/cases | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")
curl -X POST http://localhost:3001/dev/seed-fixture-emails/$CASE_ID \
  -H 'Content-Type: application/json' \
  -d '{"fixture":"inbound-hardship.eml"}'
```

Expected response includes `"outcome":{"status":"HARD_TRIGGER","trigger":"HARDSHIP_INDICATED","keyword":"I lost my job"}`. Reload the case detail in the browser — the inbound message appears in the timeline with the hardship escalation flag.

**Talking points:**

> "An email arrives: 'I lost my job, I can't pay this month.' Before we touch any AI model, a deterministic keyword filter scans the message. 'Lost my job' is in our hardship trigger set — the message routes directly to a human handler. Zero Claude tokens consumed for this message."

> "This is a safety boundary, not a performance optimisation. We never ask an LLM whether something is a hardship signal. The rule set is small and reviewed: hardship, mental health, breathing space, third-party involvement, dispute, domestic circumstances. Anything matched goes to a human."

### Scenario 6 — Tenant with guarantor

**Action:** Click into a case whose tenancy has a guarantor listed in the contacts section.

> Fixtures: stay on `tenancy-abc-001` from scenario 3 (its guarantor is `contact-guarantor-001`). Stage: any tenancy whose Rentancy record has a non-empty `guarantorIds` array.

**Talking points:**

> "The tenancy has a named guarantor. We surface them on the case so the agent has the context, but in this POC we don't run a parallel chase cadence to the guarantor — that's a Phase 2 item. The point of this scenario is that the data flow works end to end from Rentancy: guarantor in the upstream becomes guarantor on the case in our system."

## Reset between back-to-back demos

To go from "demo just finished" to "clean state for the next run":

```bash
pnpm --filter backend prisma migrate reset --force --skip-seed   # destructive; drops and recreates the DB
pnpm --filter backend seed                                       # fixtures only — seeds demo-org
# Stage: re-create your org in the UI and re-save credentials (the encrypted blob is gone with the DB)
curl -X POST http://localhost:3001/dev/force-sync/$ORG_ID
```

If you only need to clear the inbounds you injected during the demo (and keep the cases), there is no built-in undo — the cleanest path is the full reset above.

## Stage mode preflight

If `ORG_ID` is anything other than `demo-org`, you're on the stage path. Extra setup:

1. Backend `.env` has `INTEGRATION_MODE=stage`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, and the correct stage base URLs (`loftyworks-accounting.stage.pay.loftyworks.com` for LWCA, `rentancy-api.stage.pay.loftyworks.com` for Rentancy).
2. The org row + credentials exist for `$ORG_ID` (create via UI; paste your fresh **ID token** as the access token).
3. Pin the cached token's expiry so it doesn't trigger a Cognito refresh during the demo (refresh drops `custom:userId` until Lofty fixes it server-side):
   ```bash
   PGPASSWORD=arrears psql -h localhost -U arrears -d arrears_poc -c \
     "UPDATE organisation_credential SET \"accessTokenExpiresAt\" = NOW() + INTERVAL '55 minutes' WHERE \"organisationId\" = '$ORG_ID';"
   ```

Re-paste the ID token roughly hourly during long demo sessions.

## Known pitfalls

- **DB silently wiped:** the backend integration tests share the local `arrears_poc` database with the dev server. Running `pnpm test` deletes the test org's rows. Always re-seed (or re-create the stage org) before demoing.
- **No `/api` prefix:** routes are mounted at root, e.g. `POST /dev/force-sync/:orgId`, not `POST /api/dev/...`. The seed script's "next steps" hint is the source of truth.
- **Outbound is gated:** even if you approve a draft, the send goes to Mailhog at http://localhost:8025, not to a real inbox. Per the hard rule in [CLAUDE.md](../CLAUDE.md), there is no auto-send path in the POC.
- **Fixtures vs stage:** the upstream mode is set by `INTEGRATION_MODE` in `backend/.env`. Mention this during the demo if anyone asks why the data looks crafted vs lived-in.
- **Stage cross-org lock:** in stage mode, the first org that claims a tenancy holds it. To switch the same tenancies to a different `ORG_ID`, wipe the previous org first.
