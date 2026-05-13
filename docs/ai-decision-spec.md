# AI Decision Spec

This doc defines exactly when and how Claude is invoked, and — more importantly — when it is **not**. The pre-filter described here is a safety boundary, not a tuning parameter. Code reviewers verify any change to this doc has matching test changes.

## Principles

1. **Deterministic before probabilistic.** A regex/keyword classifier runs on every inbound message *before* any LLM call. Hard-trigger matches bypass the LLM entirely. The LLM never decides whether to escalate a hardship case; the pre-filter does.
2. **Drafts, not sends.** Claude produces drafts. Humans approve and send. In POC, `autoSendEnabled` is always `false`, regardless of confidence.
3. **Redact at the boundary.** No tenant PII enters a prompt unless explicitly needed for the task. Names beyond first-name greeting, addresses, phone numbers, NI numbers, dates of birth — none of these go to Anthropic.
4. **Best-effort, never silent.** Every failure mode (spend cap, rate limit, content filter, network) routes the inbound message to the review queue with a reason. The system never drops a message.
5. **Auditability.** Every classification stores model, prompt tokens, completion tokens, cost in pence, the matched pre-filter trigger (if any), and the LLM's rationale.

## The inbound pipeline

```
Inbound message lands in the shared mailbox
        │
        ▼
OutlookInboundPollJob ingests, creates Communication row (direction=INBOUND)
        │
        ▼
┌─────────────────────────────────────────────────┐
│ STEP 1: Deterministic pre-filter                │
│ Run hard-trigger regex/keyword scan             │
│ on the body (subject + raw text + normalised)   │
└─────────────────┬───────────────────────────────┘
                  │
        ┌─────────┴──────────┐
   match│                    │no match
        ▼                    ▼
┌─────────────────┐    ┌──────────────────────────────────────┐
│ ESCALATE        │    │ STEP 2: Claude classification (Haiku)│
│ - raise flag    │    │ Redact PII; build prompt with case   │
│ - URGENT RQI    │    │ context; classify sentiment+intent.  │
│ - halt tenant   │    │ Persist confidence + rationale.      │
│   chase track   │    └──────────────┬───────────────────────┘
│ - NEVER call    │                   │
│   Anthropic     │                   ▼
└─────────────────┘    ┌──────────────────────────────────────┐
                       │ STEP 3: Route on confidence + intent │
                       └──────────────┬───────────────────────┘
                                      │
                       ┌──────────────┴─────────────┐
                  high │                            │ low
                       ▼                            ▼
            ┌──────────────────────┐   ┌──────────────────────────┐
            │ Draft reply (Sonnet) │   │ INBOUND_LOW_CONFIDENCE   │
            │ Queue for approval   │   │ review queue item        │
            │ Priority NORMAL      │   │ Priority HIGH            │
            └──────────────────────┘   └──────────────────────────┘
```

## Step 1: Pre-filter (hard-trigger detection)

Runs against the full plain-text body of the inbound message after light normalisation: lowercase, collapse whitespace, strip HTML tags, decode common entities, normalise unicode (NFKC).

Six trigger categories. A message matching ANY trigger in ANY category escalates and stops the pipeline.

### Trigger definitions

**Encoded as a config-driven array** in `backend/src/modules/ai/hard-triggers.ts` so they're testable and tweakable per org via `OrganisationConfig.hardTriggerOverrides`. Default set:

#### HARDSHIP_INDICATED

```ts
[
  /\bi('?| have)\s+(lost|losing)\s+(my|the)\s+job\b/i,
  /\bmade redundant\b/i,
  /\bcan'?t\s+afford\s+to\s+pay\b/i,
  /\bno\s+money\s+to\s+(pay|live)\b/i,
  /\bcan'?t\s+make\s+(rent|the\s+payment|the\s+rent)\b/i,
  /\bbenefits?\s+(stopped|sanctioned|delayed)\b/i,
  /\bfood\s+bank\b/i,
  /\bgone\s+hungry\b/i,
  /\bfinancial\s+hardship\b/i,
  /\bevicted\b/i,
  /\bhomeless\b/i,
]
```

#### MENTAL_HEALTH_INDICATED

```ts
[
  /\bi'?m\s+(really\s+)?struggling\b/i,
  /\bnot\s+coping\b/i,
  /\bcan'?t\s+cope\b/i,
  /\bmental\s+health\b/i,
  /\bdepress(ed|ion)\b/i,
  /\banxiety\b/i,
  /\bsuicid/i,                              // suicide, suicidal — sensitive
  /\bself[\s-]?harm\b/i,
  /\bbreak\s?down\b/i,
  /\bnervous\s+break/i,
  /\bovermedicated\b/i,
  /\bin\s+hospital\b/i,
  /\bsection(ed)?\b/i,                       // colloquial mental health detention reference
]
```

#### BREATHING_SPACE

```ts
[
  /\bbreathing\s+space\b/i,
  /\bdebt\s+respite\b/i,
  /\bdebt\s+(advice|adviser|charity|management)\b/i,
  /\bcitizens?\s+advice\b/i,                  // also matches THIRD_PARTY_INVOLVED, that's fine
  /\bstep\s?change\b/i,                       // StepChange debt charity
  /\bnational\s+debtline\b/i,
  /\bpaylink\b/i,
  /\bdebt\s+respite\s+scheme\b/i,
  /\bDRS\b/,                                  // case-sensitive; avoid false positives like "addressed"
  /\binsolvency\b/i,
  /\bIVA\b/,
  /\bdebt\s+management\s+plan\b/i,
]
```

#### THIRD_PARTY_INVOLVED

```ts
[
  /\bsolicitor\b/i,
  /\blawyer\b/i,
  /\blegal\s+(advice|representative|aid)\b/i,
  /\bcouncil\b/i,                             // local authority involvement
  /\bhousing\s+officer\b/i,
  /\buniversal\s+credit\b/i,
  /\bhousing\s+benefit\b/i,
  /\bDWP\b/,
  /\bcitizens?\s+advice\b/i,
  /\bshelter\b/i,                             // homelessness charity
  /\bombudsman\b/i,
  /\btribunal\b/i,
  /\bMP\b/,                                   // contacted my MP
  /\bombudsman\b/i,
  /\bcourt\b/i,
]
```

#### LIABILITY_DISPUTED

```ts
[
  /\bi\s+don'?t\s+owe\b/i,
  /\bthis\s+isn'?t\s+my\s+debt\b/i,
  /\bnot\s+my\s+(rent|debt|charge|tenancy)\b/i,
  /\bnever\s+agreed\b/i,
  /\bdispute\s+(this|the)\s+(charge|amount|debt)\b/i,
  /\bincorrect\s+(amount|charge|balance)\b/i,
  /\balready\s+paid\b/i,
  /\bidentity\s+theft\b/i,
]
```

#### DOMESTIC_CIRCUMSTANCES

```ts
[
  /\bbereave/i,                               // bereaved, bereavement
  /\bpassed\s+away\b/i,
  /\bdied\b/i,
  /\bfuneral\b/i,
  /\bdivorce\b/i,
  /\bseparat(ed|ion)\b/i,
  /\bdomestic\s+(abuse|violence)\b/i,
  /\brefuge\b/i,
  /\brestraining\s+order\b/i,
  /\bfled\b/i,
]
```

### Pre-filter matching semantics

- **First match wins.** If a message matches both HARDSHIP and MENTAL_HEALTH, we record the first matched trigger but the resulting `EscalationFlagKind` reflects the most-severe category. Severity order: MENTAL_HEALTH > BREATHING_SPACE > DOMESTIC_CIRCUMSTANCES > HARDSHIP > THIRD_PARTY > LIABILITY_DISPUTED.
- **Word boundaries matter.** All patterns use `\b` or whitespace anchors. `"struggling with the form"` matches MENTAL_HEALTH unless we tighten the pattern — and we accept some false positives, because false-positive escalation is much cheaper than false-negative non-escalation.
- **No semantic understanding.** Pre-filter doesn't know that "I'm not struggling at all" should not match. Tough — false-positive humans-look-at-it is the safer error.

### On match

```ts
async function onHardTrigger(message: Communication, trigger: TriggerMatch) {
  await prisma.$transaction(async (tx) => {
    await tx.classificationResult.create({
      data: {
        caseId: message.caseId,
        communicationId: message.id,
        preFilterMatched: true,
        preFilterTriggerKind: trigger.kind,
        preFilterMatchedKeyword: trigger.keyword,
        // model/sentiment/intent/confidence stay NULL — LLM never ran
      },
    });
    await tx.escalationFlag.create({
      data: { caseId: message.caseId, kind: trigger.kind, raisedReason: `Inbound message matched: "${trigger.keyword}"` },
    });
    await tx.caseEvent.create({
      data: { caseId: message.caseId, kind: 'HARD_TRIGGER_MATCHED', payloadJson: { triggerKind: trigger.kind, keyword: trigger.keyword, messageId: message.id } },
    });
    await tx.reviewQueueItem.create({
      data: {
        caseId: message.caseId,
        organisationId: message.organisationId,
        kind: 'HARD_TRIGGER_ESCALATION',
        priority: 'URGENT',
        communicationId: message.id,
      },
    });
    await tx.case.update({
      where: { id: message.caseId },
      data: { awaitingHandlerAction: true },
    });
    // Suspend tenant-track scheduling: mark any pending ChaseScheduleEntry skipped.
    await tx.chaseScheduleEntry.updateMany({
      where: { caseId: message.caseId, firedAt: null },
      data: { firedAt: new Date(), skippedReason: 'BREATHING_SPACE_ACTIVE' }, // borrowed reason; or add HARD_TRIGGER variant
    });
  });
  metrics.increment('arrears.hard_triggers.matched', { kind: trigger.kind });
}
```

The Anthropic SDK is never imported by this code path. Tests assert this with a mock that throws on any call.

## Step 2: Classification (only when pre-filter did not match)

### Goal

Sentiment (POSITIVE / NEUTRAL / NEGATIVE / DISTRESSED) and intent (PAYMENT_PROMISE / PAYMENT_CONFIRMATION / QUERY / COMPLAINT / REQUEST_FOR_INFO / UNCLEAR), with a confidence score 0.00–1.00 and a one-sentence rationale.

### Model

`claude-haiku-4-5` for the classifier. Validated against allowlist.

### Redaction before prompt

The redactor strips:

- All recognisable phone numbers (`/\b(\+?\d[\d\s-]{8,}\d)\b/g` → `[phone]`)
- Email addresses other than the sender's (`[email]`)
- Postcodes (`[postcode]`)
- Sort codes (`\b\d{2}-\d{2}-\d{2}\b` → `[sort-code]`)
- Bank account numbers (`\b\d{8}\b` → `[account-number]`)
- 9-digit-with-letter NI number pattern (`[ni-number]`)
- Date-of-birth-ish patterns (`[date]`) — false-positive prone, kept conservative

The redactor does NOT strip the message body wholesale. The model needs the message text to do its job. It just removes structured PII patterns the model doesn't need.

`Redactor.assertSafe(prompt)` is called inside `AnthropicClient.classify()`. It throws if the prompt contains anything the redactor recognises but didn't strip — defence in depth.

### Prompt template (classification)

```
SYSTEM:
You are an assistant helping a UK lettings agency triage tenant emails about
overdue rent. You output a single JSON object matching the schema in the
user message — nothing else. You never invent details not in the message.

USER:
Here is an inbound email from a tenant who has overdue rent. Your job is to
classify the email's sentiment and intent.

Case context:
- Total outstanding balance: £{{balancePounds}}
- Number of overdue charges: {{chargeCount}}
- Most-overdue charge is {{maxWorkingDaysOverdue}} working days late.
- Has the tenant made any payment in the last 30 days? {{recentPaymentYesNo}}

Email body (sender: {{senderFirstName}}):
"""
{{redactedBody}}
"""

Return a JSON object with this schema:
{
  "sentiment": "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "DISTRESSED",
  "intent": "PAYMENT_PROMISE" | "PAYMENT_CONFIRMATION" | "QUERY" | "COMPLAINT" | "REQUEST_FOR_INFO" | "UNCLEAR",
  "confidence": <number from 0.0 to 1.0>,
  "rationale": "<one short sentence>"
}

Definitions:
- PAYMENT_PROMISE: the tenant commits to paying by a specific date or within
  a stated short timeframe.
- PAYMENT_CONFIRMATION: the tenant claims they have already paid.
- QUERY: the tenant is asking a question about their charges, account, or
  the rent process.
- COMPLAINT: the tenant is unhappy about the property, the agent, or the
  charges, but the email is not disputing they owe rent.
- REQUEST_FOR_INFO: the tenant is asking for documents or specific information.
- UNCLEAR: anything else, or the message is too short to classify.

Return only the JSON. Do not include code fences, prose, or explanation.
```

`{{senderFirstName}}` is the only PII included — first name only, for the model to use when referring to the tenant in its rationale.

### Parsing

Strict: parse as JSON, validate against Zod schema, on parse failure log raw output and route to `INBOUND_LOW_CONFIDENCE`. No regex extraction of fields from prose.

### Persistence

```ts
classificationResult {
  preFilterMatched: false,
  modelUsed: 'claude-haiku-4-5',
  sentiment: <parsed>,
  intent: <parsed>,
  confidence: <parsed>,
  rationale: <parsed>,
  promptTokens, completionTokens, estimatedCostPence,
}
```

## Step 3: Routing on confidence + intent

```
if confidence >= orgConfig.aiConfidenceThreshold AND intent in AUTO_DRAFTABLE_INTENTS:
    proceed to draft (Sonnet)
else:
    create ReviewQueueItem kind=INBOUND_LOW_CONFIDENCE priority=HIGH
    raise EscalationFlag AI_CONFIDENCE_FAILURE
```

`AUTO_DRAFTABLE_INTENTS = { PAYMENT_PROMISE, PAYMENT_CONFIRMATION, QUERY, REQUEST_FOR_INFO }`.

`COMPLAINT` and `UNCLEAR` always route to low-confidence queue regardless of confidence score, because we don't want auto-drafted replies to complaints.

Default threshold: `0.75`.

`DISTRESSED` sentiment forces low-confidence routing as well, regardless of intent or confidence — distress is a soft signal that a human should look at. We don't escalate as hard as a pre-filter trigger (no flag raised, no chase halt) but we do refuse to auto-draft.

## Step 4: Drafting (Sonnet)

### Model

`claude-sonnet-4-6`. The model in the org config can be changed if a new Sonnet version ships.

### Prompt template (draft reply)

```
SYSTEM:
You are drafting a reply to a tenant on behalf of a UK lettings agent. The
reply will be reviewed by a human before sending — do not pretend to be one.

Write a short, professional reply in plain English. Use the agent's name if
provided, otherwise sign as "The Lettings Team". Always reference the total
outstanding balance and the agent will check the figure before sending.

If the tenant has promised to pay, acknowledge the date but do NOT confirm
the promise as accepted — promises are reviewed separately.

If the tenant is asking a question, answer only if the answer is unambiguous
from the case context. If not, say a colleague will follow up.

Never make legal threats. Never reference Section 8 or possession proceedings.
Never agree to write off, waive, or reduce the debt.

Output the email body only — no subject line, no signature block beyond
"Best regards, The Lettings Team" or the agent's name if provided.
Output plain text. No Markdown formatting.

USER:
Case context:
- Tenant first name: {{senderFirstName}}
- Total outstanding balance: £{{balancePounds}}
- Number of overdue charges: {{chargeCount}}
- Most overdue charge: £{{maxChargeAmount}} due {{maxChargeDueDate}}, {{maxWorkingDaysOverdue}} working days late

The tenant sent this email:
"""
{{redactedBody}}
"""

Classification: intent={{intent}}, sentiment={{sentiment}}

Draft a reply.
```

### Output handling

Output is stored as plain text in `Communication.bodyMarkdown` (which we treat as plain text here). The renderer wraps it in basic HTML for the actual email. The reviewer sees both the AI's text and the rendered preview side by side in the review queue.

`draftedByAi = true` on the Communication. The review queue UI badges this clearly.

## Outbound digest drafting (separate flow, not Claude)

The daily-digest outbound (chase emails per WD3/5/8/14) does **not** use Claude. Templates are static, with mustache-style placeholders:

```
{{tenantFirstName}}, {{caseBalanceFormatted}}, {{chargesTable}},
{{mostOverdueCharge.dueDateFormatted}}, {{agentName}}, {{stage}}
```

Reasoning: chase content is regulated-adjacent and benefits from being identical across cases. Tone variation per stage is captured by *different templates*, not by Claude rewording each one. Cheaper, more predictable, fully auditable, no PII leaves the system.

Claude only drafts *replies* to inbound messages. Templates handle outbound proactive chases.

## Model selection rationale

| Use case          | Model              | Why                                                                |
| ----------------- | ------------------ | ------------------------------------------------------------------ |
| Classification    | claude-haiku-4-5   | Cheap, fast, plenty good for short-message sentiment + intent      |
| Drafting reply    | claude-sonnet-4-6  | Better tone control, better at staying within the safety rails    |
| Outbound chase    | None (templates)   | Regulated content, predictability over variety                     |

Cost on POC volume (assumption: 50 inbound messages/day, half need drafts):

```
50 classifications × ~500 input tokens × Haiku input price ≈ trivial
25 drafts × ~800 input + 200 output tokens × Sonnet pricing ≈ pence per day
```

Daily spend cap default: £5. Realistic spend: well under £1/day.

## Tests

For every fixture in `fixtures/outlook/inbound-*.eml`, an integration test asserts:

```
hardship.eml          → pre-filter match HARDSHIP_INDICATED, Anthropic mock called 0 times
mental-health.eml     → pre-filter match MENTAL_HEALTH_INDICATED, Anthropic mock called 0 times
breathing-space.eml   → pre-filter match BREATHING_SPACE, Anthropic mock called 0 times
third-party.eml       → pre-filter match THIRD_PARTY_INVOLVED, Anthropic mock called 0 times
dispute.eml           → pre-filter match LIABILITY_DISPUTED, Anthropic mock called 0 times
domestic.eml          → pre-filter match DOMESTIC_CIRCUMSTANCES, Anthropic mock called 0 times
routine-promise.eml   → pre-filter NO match, Anthropic mock called 2 times (classify + draft)
payment-confirmed.eml → pre-filter NO match, classify only (no draft for confirmation? - decision below)
query.eml             → pre-filter NO match, classify + draft
```

The zero-invocation assertions are the safety boundary. If a hardship test starts calling Claude, the test fails and the build fails.

### Decision: does PAYMENT_CONFIRMATION get an auto-draft?

Yes. A short acknowledgement reply ("Thanks, we'll check the account and confirm receipt") is helpful, doesn't carry risk, and is something tenants expect. The draft goes through review like everything else.

## What this spec does not allow

- LLM-based escalation decisions ("decide whether to escalate") — pre-filter only
- Multi-turn agent loops — single prompt per task, no agent harnesses, no tool use
- Tenant-facing autonomous responses — drafts only
- Memory across cases — every prompt is self-contained with the case context inlined
- Fine-tuning, custom models, or training on Arrears data — we use the published models as-is

## Open items

- Confidence threshold value (`0.75` is a starting point; tune after demos)
- Whether to surface AI rationale to the reviewer in the UI (probably yes; minor design decision)
- Per-organisation prompt overrides (no for POC; revisit if specific orgs need different tone)
