import type {
  AnthropicClassifyInput,
  AnthropicDraftInput,
} from './anthropic-client';

export interface BuiltPrompt {
  system: string;
  userMessage: string;
}

/**
 * Prompts kept verbatim against docs/ai-decision-spec.md. Mustache-style
 * variables are inlined here rather than rendered via a templating
 * library because (a) the prompts are short, (b) we can typecheck the
 * inputs, and (c) any change is easier to review in a diff.
 *
 * Only `senderFirstName` is PII; the body has already been redacted
 * by the caller and re-checked by `Redactor.assertSafe` inside the
 * wrapper.
 */
export function buildClassifyPrompt(input: AnthropicClassifyInput): BuiltPrompt {
  const system =
    'You are an assistant helping a UK lettings agency triage tenant emails about ' +
    'overdue rent. You output a single JSON object matching the schema in the ' +
    'user message — nothing else. You never invent details not in the message.';

  const ctx = input.caseContext;
  const userMessage = [
    'Here is an inbound email from a tenant who has overdue rent. Your job is to',
    "classify the email's sentiment and intent.",
    '',
    'Case context:',
    `- Total outstanding balance: £${formatPounds(ctx.balancePounds)}`,
    `- Number of overdue charges: ${ctx.chargeCount}`,
    `- Most-overdue charge is ${ctx.maxWorkingDaysOverdue} working days late.`,
    `- Has the tenant made any payment in the last 30 days? ${
      ctx.recentPaymentInLast30Days ? 'yes' : 'no'
    }`,
    '',
    `Email body (sender: ${input.senderFirstName}):`,
    '"""',
    input.redactedBody,
    '"""',
    '',
    'Return a JSON object with this schema:',
    '{',
    '  "sentiment": "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "DISTRESSED",',
    '  "intent": "PAYMENT_PROMISE" | "PAYMENT_CONFIRMATION" | "QUERY" | "COMPLAINT" | "REQUEST_FOR_INFO" | "UNCLEAR",',
    '  "confidence": <number from 0.0 to 1.0>,',
    '  "rationale": "<one short sentence>"',
    '}',
    '',
    'Definitions:',
    '- PAYMENT_PROMISE: the tenant commits to paying by a specific date or within a stated short timeframe.',
    '- PAYMENT_CONFIRMATION: the tenant claims they have already paid.',
    '- QUERY: the tenant is asking a question about their charges, account, or the rent process.',
    '- COMPLAINT: the tenant is unhappy about the property, the agent, or the charges, but the email is not disputing they owe rent.',
    '- REQUEST_FOR_INFO: the tenant is asking for documents or specific information.',
    '- UNCLEAR: anything else, or the message is too short to classify.',
    '',
    'Return only the JSON. Do not include code fences, prose, or explanation.',
  ].join('\n');

  return { system, userMessage };
}

export function buildDraftPrompt(input: AnthropicDraftInput): BuiltPrompt {
  const system = [
    'You are drafting a reply to a tenant on behalf of a UK lettings agent. The',
    'reply will be reviewed by a human before sending — do not pretend to be one.',
    '',
    "Write a short, professional reply in plain English. Use the agent's name if",
    'provided, otherwise sign as "The Lettings Team". Always reference the total',
    'outstanding balance and the agent will check the figure before sending.',
    '',
    'If the tenant has promised to pay, acknowledge the date but do NOT confirm',
    'the promise as accepted — promises are reviewed separately.',
    '',
    'If the tenant is asking a question, answer only if the answer is unambiguous',
    'from the case context. If not, say a colleague will follow up.',
    '',
    'Never make legal threats. Never reference Section 8 or possession proceedings.',
    'Never agree to write off, waive, or reduce the debt.',
    '',
    'Output the email body only — no subject line, no signature block beyond',
    '"Best regards, The Lettings Team" or the agent\'s name if provided.',
    'Output plain text. No Markdown formatting.',
  ].join('\n');

  const ctx = input.caseContext;
  const userMessage = [
    'Case context:',
    `- Tenant first name: ${input.senderFirstName}`,
    `- Total outstanding balance: £${formatPounds(ctx.balancePounds)}`,
    `- Number of overdue charges: ${ctx.chargeCount}`,
    `- Most overdue charge: £${formatPounds(ctx.maxChargeAmountPounds)} due ${ctx.maxChargeDueDateFormatted}, ${ctx.maxWorkingDaysOverdue} working days late`,
    ...(input.agentName ? [`- Agent name: ${input.agentName}`] : []),
    '',
    'The tenant sent this email:',
    '"""',
    input.redactedBody,
    '"""',
    '',
    `Classification: intent=${input.classification.intent}, sentiment=${input.classification.sentiment}`,
    '',
    'Draft a reply.',
  ].join('\n');

  return { system, userMessage };
}

function formatPounds(n: number): string {
  return n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
