# Demo script — Arrears POC

Stakeholder-facing walkthrough of the six demo scenarios from [`poc-scope.md`](./poc-scope.md). Assumes the local stack is running per the [README](../README.md#quick-start).

Target audience for this doc: a new engineer running the demo for the first time. Target audience for the **demo itself**: someone non-technical who wants to see what the system does end-to-end.

Total runtime: ~10 minutes if you stick to the script, ~20 minutes with questions.

## Preflight (do this 5 minutes before showing up)

1. Confirm the stack is up:
   ```bash
   curl -s http://localhost:3001/health
   # {"status":"ok"}
   ```
2. Reset the demo state (the `seed` command is idempotent; the force-sync re-populates cases):
   ```bash
   pnpm --filter backend seed
   curl -X POST http://localhost:3001/dev/force-sync/demo-org
   ```
   Expected response: `"casesOpened":3,"casesClosed":0,"status":"COMPLETED"`. Three cases means a clean run.
3. Open http://localhost:5173 in the browser. Three cases for `Demo Lettings Ltd` should be visible — `tenancy-abc-001`, `tenancy-xyz-002`, `tenancy-s8-001`.
4. Optional second tab: http://localhost:8025 — Mailhog. Empty inbox at this point. Useful if a question pulls the demo into the outbound side (approve a draft and show it landing here).

## Walkthrough

The six scenarios are ordered so the narrative builds — start with the boring case, end with the dramatic one.

### Scenario 1 — Clean tenancy (sanity baseline)

**Action:** Stay on the cases list. Point out that the list has three cases despite the upstream having more tenancies on the books.

**Talking points:**

> "We poll LWCA on a schedule and only open cases for tenancies with overdue charges. A tenant who pays on time never appears here. That's the sanity baseline — the system stays quiet when there's nothing to chase, which is most of the time."

### Scenario 2 — Early arrears

**Action:** Click into the case for `Sam Renter` / `tenancy-xyz-002`. Single charge, £1,200, recent due date.

**Talking points:**

> "Single charge, just past due. No chase history yet, no inbound from the tenant. This is what a first-touch case looks like — early enough that the right action is a polite first reminder, not legal threats."

### Scenario 3 — Multi-charge case

**Action:** Back to the cases list. Click into `Jane Tenant` / `tenancy-abc-001`. Two charges totalling £2,000.

**Talking points:**

> "Multiple overdue charges on one tenancy. Without consolidation we'd send two separate chase emails today. The daily digest job aggregates them into one draft, with both charges itemised in the body, and picks the template that matches the most-severe stage. The agent sees one item in the review queue, not two."

### Scenario 4 — Section 8 threshold

**Action:** Back to the cases list. Click into `Priya Patel` / `tenancy-s8-001`. Four unpaid charges, £4,800 total. The S8 banner should be visible on the case detail.

**Talking points:**

> "Balance is £4,800. The Section 8 threshold is three months' rent — £3,600 — so the system flags this case. Any drafts on it get bumped to URGENT priority in the review queue. We do not generate Section 8 paperwork — that's a legal step the agent handles in their own systems. The flag is purely informational and gives the agent an early signal."

> "If the tenant later pays enough to drop below the threshold, the flag clears automatically. If breathing space is active, the flag is suppressed entirely regardless of balance."

### Scenario 5 — Hard-trigger inbound

**Action:** Grab the case ID for one of the cases (any will do; `abc-001` reads well):

```bash
curl -s http://localhost:3001/organisations/demo-org/cases \
  | python3 -c "import json,sys;print([c for c in json.load(sys.stdin) if c['tenancyId']=='tenancy-abc-001'][0]['id'])"
```

Inject the fixture inbound:

```bash
curl -X POST http://localhost:3001/dev/seed-fixture-emails/<caseId> \
  -H 'Content-Type: application/json' \
  -d '{"fixture":"inbound-hardship.eml"}'
```

Expected response includes `"outcome":{"status":"HARD_TRIGGER","trigger":"HARDSHIP_INDICATED","keyword":"I lost my job"}`. Reload the case detail in the browser — the inbound message appears in the timeline with the hardship escalation flag.

**Talking points:**

> "An email arrives: 'I lost my job, I can't pay this month.' Before we touch any AI model, a deterministic keyword filter scans the message. 'Lost my job' is in our hardship trigger set — the message routes directly to a human handler. Zero Claude tokens consumed for this message."

> "This is a safety boundary, not a performance optimisation. We never ask an LLM whether something is a hardship signal. The rule set is small and reviewed: hardship, mental health, breathing space, third-party involvement, dispute, domestic circumstances. Anything matched goes to a human."

### Scenario 6 — Tenant with guarantor

**Action:** Stay on `abc-001`. Point at the guarantor row in the contact section of the case detail.

**Talking points:**

> "The tenancy has a named guarantor. We surface them on the case so the agent has the context, but in this POC we don't run a parallel chase cadence to the guarantor — that's a Phase 2 item. The point of this scenario is that the data flow works end to end from Rentancy: guarantor in the upstream becomes guarantor on the case in our system."

## Reset between back-to-back demos

To go from "demo just finished" to "clean state for the next run":

```bash
pnpm --filter backend prisma migrate reset --force --skip-seed   # destructive; drops and recreates the DB
pnpm --filter backend seed
curl -X POST http://localhost:3001/dev/force-sync/demo-org
```

If you only need to clear the inbounds you injected during the demo (and keep the cases), there is no built-in undo — the cleanest path is the full reset above.

## Known pitfalls

- **DB silently wiped:** the backend integration tests share the local `arrears_poc` database with the dev server. Running `pnpm test` deletes `demo-org` rows. Always re-seed before demoing.
- **No `/api` prefix:** routes are mounted at root, e.g. `POST /dev/force-sync/:orgId`, not `POST /api/dev/...`. The seed script's "next steps" hint is the source of truth.
- **Outbound is gated:** even if you approve a draft, the send goes to Mailhog at http://localhost:8025, not to a real inbox. Per the hard rule in [CLAUDE.md](../CLAUDE.md), there is no auto-send path in the POC.
- **Fixtures mode:** the local stack runs `INTEGRATION_MODE=fixtures` — upstream payloads come from `fixtures/`, not the real LWCA stage. Any credential in the UI is accepted. Don't read this as "live stage data" during the demo.
