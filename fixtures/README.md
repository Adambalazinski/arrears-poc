# Fixtures

Representative payloads from each upstream system, plus inbound email scenarios for the AI pipeline.

When `INTEGRATION_MODE=fixtures`, the integration clients read from this directory instead of making HTTP calls. Used by tests and by offline dev.

## Layout

```
fixtures/
├── lwca/                  LWCA Accounting API responses
├── rentancy/              Rentancy API responses (tenancies, contacts)
├── outlook/               .eml files representing inbound messages
└── anthropic/             Pre-recorded classifier responses (for offline mode)
```

## LWCA fixtures

- `invoices-list-early-arrears.json` — single charge overdue, used for first-case-open scenario
- `invoices-list-multi-charge.json` — three charges at different ages on one tenancy, used for digest consolidation

(Add more as scenarios emerge: `invoices-list-s8-threshold.json` with balance ≥ 3 months' rent; `invoices-list-clean-tenancy.json` with no overdue charges; `invoice-paid-after-draft.json` for balance-changed flow.)

## Rentancy fixtures

- `tenancy-with-guarantor.json` — one tenant, one guarantor
- `contact-tenant.json` — the tenant from above
- `contact-guarantor.json` — the guarantor from above

## Outlook fixtures

Each `.eml` is a self-contained email with valid headers. The mail parser in the inbound pipeline reads these in tests.

### Hard-trigger fixtures (pre-filter must match, Anthropic must NOT be called)

- `inbound-hardship.eml` — HARDSHIP_INDICATED ("lost my job", "can't afford to pay")
- `inbound-mental-health.eml` — MENTAL_HEALTH_INDICATED ("really struggling", "not coping")
- `inbound-breathing-space.eml` — BREATHING_SPACE (StepChange, breathing space scheme, debt management plan)
- `inbound-third-party.eml` — THIRD_PARTY_INVOLVED (Citizens Advice, MP)
- `inbound-dispute.eml` — LIABILITY_DISPUTED ("I don't owe this", "already paid")
- `inbound-domestic.eml` — DOMESTIC_CIRCUMSTANCES (bereavement)

### Routine fixtures (no pre-filter match, Anthropic classifies)

- `inbound-routine-promise.eml` — should classify as PAYMENT_PROMISE, auto-draft
- `inbound-payment-confirmed.eml` — should classify as PAYMENT_CONFIRMATION, auto-draft acknowledgement
- `inbound-query.eml` — should classify as QUERY, auto-draft if balance breakdown is unambiguous

## Tests using fixtures

Every fixture has an assertion in the pre-filter test suite. Adding a fixture without adding its assertion fails CI (a lint rule scans both directories).

## Adding fixtures

Real anonymised payloads are better than synthetic ones. When you have a real upstream response (with PII redacted), save it here with a descriptive name and add the corresponding test case.
