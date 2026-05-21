# Business Rules

Rules that drive the system, written as concise statements with worked examples. Tests in `backend/src/modules/*/__tests__/rules/` reference rule IDs and are the rigorous specification.

For the AI-side rules (pre-filter, classification, drafting), see `docs/ai-decision-spec.md`. This doc covers everything else.

## Glossary

- **Case** — an open arrears episode on a tenancy. One active case per tenancy at a time.
- **Charge** — a single overdue invoice, mirrored from LWCA. Many charges per case.
- **WD** — working day. UK England & Wales calendar. WD0 is the charge's due date itself.
- **Stage** — the current cadence position of a charge: `AWAITING_WD3`, `WD3_SENT`, etc.
- **Digest** — the consolidated outbound message sent once per case per day, covering all charge events firing that day.
- **Hard trigger** — an inbound-message keyword/regex match that causes immediate escalation. See `docs/ai-decision-spec.md`.

## Rule R1 — Case opens

**R1.1.** When the polling job ingests an LWCA invoice that:
- has `status` in `UNPAID`, `PARTIALLY_PAID`, `PARTIALLY_RECONCILED`,
- has `remainAmount > 0`,
- has `paymentCycleType != RECURRING`,
- has `dueDate <= today` (Europe/London),

...and no `ACTIVE` case exists for that invoice's `tenancyId`, then a new `Case` is opened with `status=ACTIVE`, `openedAt=now()`, and the charge is attached to it.

**R1.2.** When such an invoice is ingested and an `ACTIVE` case already exists on the same tenancy, the charge is attached to that case (no second case opens).

**R1.3.** The partial unique index in Postgres guarantees R1.2: any attempt to create a second active case fails the transaction.

### Example

Tenancy `T1` has no open case. LWCA returns two invoices: INV-A due 1 March (remain £600), INV-B due 1 April (remain £1,200), both overdue today (1 May).

Outcome: one case opens at the moment INV-A is first seen. INV-B attaches to the same case on the same poll tick. Case balance is £1,800.

## Rule R2 — Case closes

**R2.1.** A case closes when, after charge syncs complete:
- every charge on the case has `lastKnownStatus` in `PAID`, `RECONCILED`, or `DELETED`, AND
- `lastKnownBalancePence` (sum of remains) is 0.

**R2.2.** On closure: `status=CLOSED`, `closedAt=now()`, a `CASE_CLOSED` event is emitted, any pending `ChaseScheduleEntry` rows are marked skipped with reason `CASE_CLOSED`, any unresolved `ReviewQueueItem` rows for outbound drafts on the case are auto-rejected with reason "case closed".

**R2.3.** Closed cases are never reopened. If new arrears appear on the same tenancy later, a new case opens.

### Example

Case `C1` has INV-A (paid in full) and INV-B (remain £200). Tenant pays £200. Next poll: INV-B `remainAmount=0, status=PAID`. Case balance becomes 0, all charges in final states. Case closes.

If a week later INV-C goes overdue on the same tenancy: new case `C2` opens. `C1` stays closed.

## Rule R3 — Per-charge cadence

**R3.1.** Each charge runs its own working-day cadence anchored to the charge's `dueDate`. Stages fire on WD3, WD5, WD8, and WD14 by default — configurable per organisation.

**R3.2.** Working days count `dueDate` as WD0. A charge due Monday 5 May reaches WD3 on Thursday 8 May (assuming no bank holidays). A charge due Friday 2 May reaches WD3 on Wednesday 7 May.

**R3.3.** `ChaseTickJob` runs hourly. For each charge in arrears states, it computes `workingDaysOverdue` against today. If a WD threshold is crossed and no `ChaseScheduleEntry` exists for `(chargeId, stage)`, it creates one with `dueAt=today_09:00_London` and `firedAt=NULL`.

**R3.4.** `currentStage` on `Charge` advances when a schedule entry is created. The entry being created is the side effect; the stage advance is for fast UI reads.

**R3.5.** If a charge is partly paid (status changes to `PARTIALLY_PAID` or `PARTIALLY_RECONCILED`) but the remainder is still > 0, cadence continues. The stage does **not** step back in POC (see "Out of scope" below).

### Example

INV-A due Mon 5 May. Working days, no holidays:
- WD3 = Thu 8 May → AWAITING_WD3 entry created at the 09:00 tick
- WD5 = Mon 12 May → AWAITING_WD5 entry created
- WD8 = Thu 15 May → AWAITING_WD8 entry created
- WD14 = Fri 23 May → AWAITING_WD14 entry created (exec-notify stage)

## Rule R4 — Daily digest

**R4.1.** `DailyDigestJob` runs at 09:00 Europe/London. For each case with one or more `ChaseScheduleEntry` rows that have `dueAt <= now()` and `firedAt = NULL`, it produces **one** outbound `Communication` covering all of them.

**R4.2.** The digest's `consolidatedStage` is the most severe stage among the entries. Severity order: `AWAITING_WD14` > `AWAITING_WD8` > `AWAITING_WD5` > `AWAITING_WD3`. The template chosen for the message body matches `consolidatedStage`.

**R4.3.** The message body itemises every overdue charge on the case (not just the ones firing that day). Each line: charge reference, due date, original amount, remaining amount, working days overdue. Followed by the consolidated balance and the next-step language matching the stage.

**R4.4.** When the digest is created: all included `ChaseScheduleEntry` rows are marked `firedAt=now()`. A `Communication` (`direction=OUTBOUND`, `status=AWAITING_APPROVAL`, `draftedByAi=false`) is created with `consolidatedStage` set. A `ReviewQueueItem` is created with `kind=OUTBOUND_DRAFT_APPROVAL`. Priority is `NORMAL`; `HIGH` if WD14 is included; `URGENT` if the case has `s8Eligible=true`.

**R4.5.** A case with breathing space active produces no tenant-track digest. Schedule entries that come due during breathing space are immediately marked `skippedReason=BREATHING_SPACE_ACTIVE` on creation.

### Example

Case `C1` has three charges. Today's 09:00 tick fires:
- INV-A entered AWAITING_WD5 → entry due today
- INV-B entered AWAITING_WD8 → entry due today (most severe)
- INV-C (not overdue yet) → no entry

Digest produced at 09:00:
- Most-severe stage: AWAITING_WD8 → template "wd8 tenant"
- Body lists INV-A, INV-B, INV-C (all overdue charges on the case)
- Both entries on INV-A and INV-B marked fired
- One ReviewQueueItem, priority HIGH (WD8 included)

## Rule R5 — Live balance for every threshold

**R5.1.** Any rule that compares balance to a threshold (S8 check, case-close check, balance-changed-since-draft check) must first re-sync every relevant charge from LWCA before evaluating.

**R5.2.** "Re-sync" means a fresh `GET /v1/api/invoice` call filtered by property and status, mapping the response, updating `Charge.lastKnownRemainAmountPence` and `Charge.lastKnownStatus` for each matched invoice in the same DB transaction as the rule evaluation.

**R5.3.** UI list views read `lastKnownBalancePence` directly — they don't re-sync per request. Only rule evaluation triggers re-sync. The list view shows `lastSyncedAt` so the user knows freshness.

**R5.4.** Re-sync within a single rule evaluation may use a request-scoped in-memory cache (e.g. one rule call needs the same charge twice). Cache lifetime is bounded by the request; it never crosses request boundaries.

## Rule R6 — Section 8 eligibility

**R6.1.** A case is "S8 eligible" when its live balance (per R5) is greater than or equal to **the lesser of**:
- 3 months' rent (using `Tenancy.rentAmountPence × 3`), OR
- 13 weeks' rent (using `Tenancy.rentAmountPence × 13 / 4`)

The org config exposes both `s8RentMonthsThreshold` and `s8WeeksThreshold`; both are 3 and 13 by default.

**R6.2.** When eligibility transitions FALSE → TRUE: raise `EscalationFlag` kind `S8_ELIGIBLE`, set `Case.s8Eligible=true`, emit `S8_ELIGIBILITY_RAISED` event. Notification surface: case detail page banner; review queue priority for any drafts on the case becomes `URGENT`.

**R6.3.** When eligibility transitions TRUE → FALSE (e.g. tenant pays enough to drop below threshold): clear the flag, set `Case.s8Eligible=false`, emit `S8_ELIGIBILITY_RESCINDED` event.

**R6.4.** Yo-yo: if eligibility transitions back to TRUE later, the flag is raised again. We track only the *current* state — historical raise/clear events on the timeline are the audit.

**R6.5.** The system does not generate, send, or store Section 8 paperwork. The flag is informational.

**R6.6.** Breathing space active suppresses the S8 flag entirely. `Case.s8Eligible` stays `false` while `breathingSpaceActive` is true, even if the balance is over threshold.

### Example

Tenancy `T1` rent £1,000/month. S8 threshold = min(£3,000, £3,250) = £3,000.

- Case balance £2,800 → not eligible
- Balance climbs to £3,100 (next month's rent goes overdue) → flag raised, banner appears
- Tenant pays £400 → balance £2,700 → flag cleared, banner gone
- Two months later balance £3,500 → flag raised again

## Rule R7 — Breathing space

**R7.1.** A case has two ways to enter breathing space:

- **R7.1.a — Formal notification.** A handler clicks "Activate breathing space" on the case detail, selects source `FORMAL_NOTIFICATION`, optionally adds a note. Used when an external formal Debt Respite notification has been received.
- **R7.1.b — Tenant mention via email.** Inbound pre-filter matches the `BREATHING_SPACE` trigger. The case auto-enters breathing space.

Both produce the same downstream state.

**R7.2.** While breathing space is active:
- All tenant-track chase events on this case are suspended. New `ChaseScheduleEntry` rows reaching due time are marked skipped with reason `BREATHING_SPACE_ACTIVE`.
- Pending outbound `Communication` rows with `recipientRole=TENANT` and `status` in `AWAITING_APPROVAL` or `APPROVED` are auto-rejected with reason "breathing space active".
- The `S8_ELIGIBLE` flag is forced off regardless of balance (R6.6).
- Guarantor-track communications and the daily digest can continue if/when the guarantor track is built (post-MVP).
- New rent monitoring continues — i.e. new overdue charges still flow in via polling, but they attach to the case silently without firing any cadence.

**R7.3.** Deactivation: handler clicks "Deactivate breathing space" with optional note. Past skipped entries are NOT retroactively fired. Cadence resumes from the next tick that finds new schedule entries to create.

**R7.4.** Breathing space is a `Case`-level flag, not a tenancy-level one. A future case on the same tenancy starts without it.

## Rule R8 — Partial payment treatment

**R8.1.** Partial payments are detected via LWCA invoice sync. When a charge's `lastKnownStatus` becomes `PARTIALLY_PAID` or `PARTIALLY_RECONCILED` and `lastKnownRemainAmountPence` decreases compared to the previous sync, the system:

- Updates the charge row.
- Recomputes case balance.
- Emits `CHARGE_PARTIALLY_PAID` event with the delta.

**R8.2.** Cadence stage steps back on partial payment. Driven by the cumulative paid fraction `(gross − remain) / gross`:

- **≥ 90% paid (reset to WD3).** The charge's `cadenceCycle` increments, `cadenceAnchorAt` is set to now, `currentStage` resets to `NOT_DUE`, and a `CHARGE_CADENCE_RESET` event is emitted. Working-day-overdue is recomputed against the new anchor, so the cooperative payer gets a 3-WD grace window before any new chase fires.
- **< 90% paid (step back one stage).** From AWAITING_WD14/WD14_NOTIFIED the target is AWAITING_WD8; from AWAITING_WD8/WD8_SENT it's AWAITING_WD5; from AWAITING_WD5/WD5_SENT it's AWAITING_WD3. The cycle increments, `cadenceAnchorAt` is set to `now − (target stage WD) working days`, `currentStage` resets to `NOT_DUE`, and a `CHARGE_CADENCE_STEPPED_BACK` event is emitted. The next chase tick re-discovers the target stage and creates a fresh `ChaseScheduleEntry` for it (now allowed because the unique index includes `cadenceCycle`).
- **Floor (AWAITING_WD3 / WD3_SENT) or pre-cadence (NOT_DUE / RESOLVED).** No cadence change. The `CHARGE_PARTIALLY_PAID` event still records the payment.

`ChaseScheduleEntry` uniqueness is keyed on `(chargeId, cadenceCycle, stage, recipientRole)`. Entries from previous cycles remain in the DB for audit but are ignored when computing `currentStage` (the cycle filter excludes them).

**R8.3.** The S8 flag is reevaluated on every partial payment (R6).

**R8.4.** The next outbound digest after a partial payment will include the partial-payment fact in the body via a template variable — "an amount of £X was received on [date]; your remaining balance is £Y" — so the tenant gets a balance-aware message.

### Example

Charge INV-A: gross £1,200, remain £1,200, status `UNPAID`, stage AWAITING_WD8. Tenant pays £700.

Next poll: status `PARTIALLY_PAID`, remain £500. Cumulative paid = £700 / £1,200 = 58% (< 90%) → step back from AWAITING_WD8 → AWAITING_WD5. `cadenceCycle` becomes 1, `cadenceAnchorAt` is set to `today − 5 working days`, `currentStage` resets to `NOT_DUE`. Next chase tick sees wd-overdue=5 against the new anchor and creates an AWAITING_WD5 entry tagged `cadenceCycle=1`. The next digest sends a WD5-template message acknowledging the £700 receipt and showing £500 still owing.

## Rule R9 — Balance-changed-since-draft

**R9.1.** When a reviewer clicks Approve on an outbound draft, the system re-fetches all linked charges from LWCA (per R5).

**R9.2.** If any charge's `remainAmount` has changed by more than 1p (rounding-safe) since the draft was generated, OR if any charge's `status` has changed in a way that would zero its contribution (`PAID`, `RECONCILED`, `DELETED`), the send is blocked and the reviewer sees a "balance changed — regenerate?" prompt.

**R9.3.** Regenerating produces a new draft from the current state and resolves the old draft as `REJECTED` with reason "stale, regenerated".

**R9.4.** This rule exists to prevent sending "you owe £1,200" after a payment landed in LWCA.

## Rule R10 — Hard-trigger response

Defined in `docs/ai-decision-spec.md` Step 1. Summary here for completeness:

**R10.1.** Hard-trigger keyword/regex match on any inbound message: case enters escalated state, tenant-track chase halts, URGENT review queue item created, Anthropic API is not called.

**R10.2.** The handler reviewing an escalation can decide to deactivate the flag (returning the case to normal cadence) or to take the case off automated handling entirely (which is recorded as a flag but does not change the schema — practically, the handler stops the cadence by activating breathing space and choosing not to deactivate).

## Rule R11 — Sender matching for inbound

**R11.1.** Inbound sender email is matched to `Contact.primaryEmail` first, then to entries in `Contact.emailsJson` if no primary match.

**R11.2.** Matching is org-aware: a sender's email must match a Contact within an organisation that has at least one active case for that contact's tenancy.

**R11.3.** Ambiguous match (sender matches multiple contacts across different organisations): the message is parked on a "needs triage" admin page. Not routed automatically. The handler picks the right case.

**R11.4.** No match: the message is stored with sender as text only, no case linkage. Surfaced on the same admin page.

## Configuration (per organisation)

Stored in `OrganisationConfig`. Defaults are the TLP BRD values.

| Config field                | Default                  | What it controls                                                    |
| --------------------------- | ------------------------ | ------------------------------------------------------------------- |
| `chaseDayFirst`             | 3                        | WD threshold for first chase                                        |
| `chaseDaySecond`            | 5                        | WD threshold for second chase                                       |
| `chaseDayThird`             | 8                        | WD threshold for third + formal notice                              |
| `chaseDayExecNotify`        | 14                       | WD threshold for exec notification                                  |
| `workingDayCalendar`        | england-and-wales        | gov.uk bank-holidays division                                       |
| `s8RentMonthsThreshold`     | 3                        | Months-of-rent threshold for S8 flag                                |
| `s8WeeksThreshold`          | 13                       | Weeks-of-rent threshold for S8 flag                                 |
| `pollingIntervalMinutes`    | 15                       | LWCA polling frequency                                              |
| `autoSendEnabled`           | false                    | Master kill switch for auto-send. STAYS FALSE IN POC.               |
| `aiClassificationModel`     | claude-haiku-4-5         | Anthropic model for classification                                  |
| `aiDraftModel`              | claude-sonnet-4-6        | Anthropic model for drafting                                        |
| `aiConfidenceThreshold`     | 0.75                     | Above which to auto-draft                                           |
| `templateWd3Tenant`         | BRD template             | Template for tenant chase, WD3 stage                                |
| `templateWd5Tenant`         | BRD template             | Template for tenant chase, WD5 stage                                |
| `templateWd8Tenant`         | BRD template             | Template for tenant chase, WD8 + formal notice stage                |
| `templateWd14Tenant`        | BRD template             | Template for tenant chase, WD14 stage (exec notification)           |
| `templateBrokenPromise`     | BRD template             | Reserved for post-MVP promise workflow                              |
| `hardTriggerOverrides`      | null                     | JSON override of default hard-trigger keywords                      |

## Template variables

Available in all chase templates:

```
{{tenant.firstName}}
{{tenant.lastName}}
{{property.address}}
{{property.name}}
{{case.balanceFormatted}}                  e.g. "£2,400.00"
{{case.balancePence}}                      e.g. 240000
{{case.chargeCount}}
{{case.openedDate}}
{{charges}}                                array; iterate with #each
  {{this.referenceId}}
  {{this.dueDateFormatted}}
  {{this.grossAmountFormatted}}
  {{this.remainAmountFormatted}}
  {{this.workingDaysOverdue}}
{{mostOverdueCharge}}                      same shape as a single charge
{{agency.name}}
{{agency.replyEmail}}
```

Mustache-style rendering (no JS execution, no helpers beyond basic iteration and conditionals).

## Out of scope for POC

Pinned for clarity, will be added in later slices:

- **Promise workflow** — payment promises detected by AI or logged manually, with one-active-per-case, two-per-cycle, 15-day-max-window, broken-promise template, etc.
- **Guarantor parallel cadence** — guarantor data flows through (contacts visible on case), but no parallel chase events fire
- **WhatsApp** — communication channel reserved in schema, not built
- **Cross-case history** — clean slate per case (R10 ish): every new case ignores patterns from prior closed cases
- **Custom rule authoring** — config exposes parameter overrides only, not arbitrary rule editing
- **Pattern-based escalation triggers** ("3+ consecutive small payments", "stale balance 60 days") — schema includes the flag kinds, the rule logic to raise them is post-MVP
