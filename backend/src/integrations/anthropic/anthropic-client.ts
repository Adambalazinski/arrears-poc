import { Injectable } from '@nestjs/common';

/**
 * DI token for the Anthropic client seam.
 *
 * Phase 7.3 introduced this token plus a throw-on-call placeholder.
 * Phase 7.4 lands the real `@anthropic-ai/sdk`-backed implementation in
 * `anthropic-http-client.ts`; the provider factory in
 * `anthropic.module.ts` selects between them on `ANTHROPIC_MODE`.
 *
 * Wherever this token surfaces, no other module imports the SDK
 * directly — that boundary is the basis for the "zero LLM call on
 * hard-trigger" safety tests.
 */
export const ANTHROPIC_CLIENT = Symbol('ANTHROPIC_CLIENT');

/** Sentiment + intent values per docs/ai-decision-spec.md. */
export type AnthropicSentiment = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'DISTRESSED';
export type AnthropicIntent =
  | 'PAYMENT_PROMISE'
  | 'PAYMENT_CONFIRMATION'
  | 'QUERY'
  | 'COMPLAINT'
  | 'REQUEST_FOR_INFO'
  | 'UNCLEAR';

export interface AnthropicClassifyInput {
  /** Optional override; defaults to `claude-haiku-4-5`. Must be in the allowlist. */
  modelId?: string;
  organisationId: string;
  caseId: string;
  /** Body redacted by the caller; the wrapper still re-runs assertSafe. */
  redactedBody: string;
  /** First-name greeting only — full PII is redacted out. */
  senderFirstName: string;
  caseContext: {
    balancePounds: number;
    chargeCount: number;
    maxWorkingDaysOverdue: number;
    recentPaymentInLast30Days: boolean;
  };
}

export interface AnthropicClassifyResult {
  modelUsed: string;
  sentiment: AnthropicSentiment;
  intent: AnthropicIntent;
  confidence: number;
  rationale: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCostPence: number;
}

export interface AnthropicDraftInput {
  modelId?: string; // defaults to claude-sonnet-4-6
  organisationId: string;
  caseId: string;
  redactedBody: string;
  senderFirstName: string;
  caseContext: {
    balancePounds: number;
    chargeCount: number;
    maxChargeAmountPounds: number;
    maxChargeDueDateFormatted: string;
    maxWorkingDaysOverdue: number;
  };
  classification: {
    sentiment: AnthropicSentiment;
    intent: AnthropicIntent;
  };
  agentName?: string;
}

export interface AnthropicDraftResult {
  modelUsed: string;
  bodyMarkdown: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCostPence: number;
}

export interface AnthropicClient {
  classify(input: AnthropicClassifyInput): Promise<AnthropicClassifyResult>;
  draftReply(input: AnthropicDraftInput): Promise<AnthropicDraftResult>;
}

// ---------- Typed errors ----------

export class AnthropicSpendCapExceeded extends Error {
  constructor(
    message: string,
    public readonly spentTodayPence: number,
    public readonly capPence: number,
  ) {
    super(message);
    this.name = 'AnthropicSpendCapExceeded';
  }
}

export class AnthropicJsonParseError extends Error {
  constructor(
    message: string,
    public readonly rawOutput: string,
  ) {
    super(message);
    this.name = 'AnthropicJsonParseError';
  }
}

export class AnthropicEmptyContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnthropicEmptyContentError';
  }
}

// ---------- Placeholder client ----------

/**
 * Throw-on-call placeholder used when ANTHROPIC_MODE != 'live'. The
 * inbound pipeline injects this in local dev so accidental classify /
 * draft calls fail loudly instead of leaking out to a real key. The
 * hard-trigger tests inject their own no-op spy.
 */
@Injectable()
export class NotImplementedAnthropicClient implements AnthropicClient {
  classify(): Promise<AnthropicClassifyResult> {
    return Promise.reject(
      new Error(
        'AnthropicClient.classify: ANTHROPIC_MODE is not "live" — set it (and ANTHROPIC_API_KEY) to enable the real wrapper.',
      ),
    );
  }

  draftReply(): Promise<AnthropicDraftResult> {
    return Promise.reject(
      new Error(
        'AnthropicClient.draftReply: ANTHROPIC_MODE is not "live" — set it (and ANTHROPIC_API_KEY) to enable the real wrapper.',
      ),
    );
  }
}
