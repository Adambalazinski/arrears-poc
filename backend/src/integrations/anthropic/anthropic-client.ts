import { Injectable } from '@nestjs/common';

/**
 * DI token for the Anthropic client seam. Phase 7.3 introduces this so
 * the InboundPipelineService can depend on it; Phase 7.4 swaps the
 * provider for the real `@anthropic-ai/sdk`-backed implementation.
 *
 * The token exists primarily as a safety boundary: callers that reach
 * for the LLM before Phase 7.4 — or for hard-trigger inbound messages
 * at any time — must not invoke it. The default `NotImplementedAnthropicClient`
 * throws on any call so accidental wiring shows up loudly in tests.
 */
export const ANTHROPIC_CLIENT = Symbol('ANTHROPIC_CLIENT');

/** Shapes are stubbed in 7.3. 7.6 / 7.7 flesh them out. */
export interface AnthropicClassifyInput {
  organisationId: string;
  caseId: string;
  redactedBody: string;
  senderFirstName: string;
  caseContext: Record<string, unknown>;
}

export interface AnthropicClassifyResult {
  modelUsed: string;
  sentiment: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'DISTRESSED';
  intent:
    | 'PAYMENT_PROMISE'
    | 'PAYMENT_CONFIRMATION'
    | 'QUERY'
    | 'COMPLAINT'
    | 'REQUEST_FOR_INFO'
    | 'UNCLEAR';
  confidence: number;
  rationale: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCostPence: number;
}

export interface AnthropicDraftInput {
  organisationId: string;
  caseId: string;
  redactedBody: string;
  senderFirstName: string;
  caseContext: Record<string, unknown>;
  classification: Pick<AnthropicClassifyResult, 'sentiment' | 'intent'>;
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

/**
 * Throw-on-call placeholder. Phase 7.4 replaces this with the real wrapper.
 * Code paths that route to hard-trigger escalation must never reach it; the
 * inbound-pipeline tests rely on this to make accidental invocation loud.
 */
@Injectable()
export class NotImplementedAnthropicClient implements AnthropicClient {
  classify(): Promise<AnthropicClassifyResult> {
    return Promise.reject(
      new Error(
        'AnthropicClient.classify is not implemented yet (Phase 7.4 lands the real wrapper)',
      ),
    );
  }

  draftReply(): Promise<AnthropicDraftResult> {
    return Promise.reject(
      new Error(
        'AnthropicClient.draftReply is not implemented yet (Phase 7.7 lands the real wrapper)',
      ),
    );
  }
}
