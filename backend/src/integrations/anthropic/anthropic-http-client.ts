import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { Clock } from '../../common/clock/clock.service';
import { REDACTOR, type Redactor } from '../../modules/ai/redactor';
import { PrismaService } from '../prisma/prisma.service';
import {
  AnthropicEmptyContentError,
  AnthropicJsonParseError,
  AnthropicSpendCapExceeded,
  type AnthropicClassifyInput,
  type AnthropicClassifyResult,
  type AnthropicClient,
  type AnthropicDraftInput,
  type AnthropicDraftResult,
} from './anthropic-client';
import { assertModelAllowed, computeCostPence } from './pricing';
import { buildClassifyPrompt, buildDraftPrompt } from './prompts';

/**
 * Minimal structural interface for the @anthropic-ai/sdk Messages API.
 *
 * Keeping the wrapper depend on a structural type instead of the SDK's
 * own classes means tests can inject a plain object and the production
 * factory in anthropic.module.ts can hand in the real SDK without
 * changing this file when the SDK version bumps.
 */
export const ANTHROPIC_SDK = Symbol('ANTHROPIC_SDK');

export interface AnthropicSdkCreateParams {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: 'user'; content: string }>;
}

export interface AnthropicSdkContentBlock {
  type: string;
  text?: string;
}

export interface AnthropicSdkResponse {
  content: AnthropicSdkContentBlock[];
  model?: string;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason?: string | null;
}

export interface AnthropicSdkLike {
  messages: { create(params: AnthropicSdkCreateParams): Promise<AnthropicSdkResponse> };
}

const DEFAULT_CLASSIFY_MODEL = 'claude-haiku-4-5';
const DEFAULT_DRAFT_MODEL = 'claude-sonnet-4-6';
const CLASSIFY_MAX_OUTPUT_TOKENS = 256;
const DRAFT_MAX_OUTPUT_TOKENS = 600;
const DEFAULT_DAILY_CAP_GBP = 5;

const ClassifyJsonSchema = z.object({
  sentiment: z.enum(['POSITIVE', 'NEUTRAL', 'NEGATIVE', 'DISTRESSED']),
  intent: z.enum([
    'PAYMENT_PROMISE',
    'PAYMENT_CONFIRMATION',
    'QUERY',
    'COMPLAINT',
    'REQUEST_FOR_INFO',
    'UNCLEAR',
  ]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
});

/**
 * Real Anthropic wrapper per docs/integrations.md §4. The factory in
 * anthropic.module.ts selects this when ANTHROPIC_MODE=live and a key
 * is available; otherwise the throw-on-call placeholder is used.
 *
 * Every call:
 *   1. Validates the model against MODEL_ALLOWLIST.
 *   2. Builds the prompt (verbatim against docs/ai-decision-spec.md).
 *   3. Runs Redactor.assertSafe(prompt) — defence-in-depth.
 *   4. Aggregates today's estimatedCostPence and refuses if the cap
 *      is already reached (typed AnthropicSpendCapExceeded).
 *   5. Hits the SDK; the SDK handles retry/backoff for 429 + 5xx.
 *   6. For classify, JSON-parses + Zod-validates the response; raises
 *      AnthropicJsonParseError on failure.
 *   7. Computes cost from usage tokens, logs tokens+cost+latency.
 *
 * Persisting the ClassificationResult row (which feeds the spend-cap
 * aggregate next time) is the caller's responsibility — Phase 7.6
 * lands that wiring.
 */
@Injectable()
export class AnthropicHttpClient implements AnthropicClient {
  private readonly logger = new Logger(AnthropicHttpClient.name);
  private readonly dailyCapPence: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    @Inject(ANTHROPIC_SDK) private readonly sdk: AnthropicSdkLike,
    @Inject(REDACTOR) private readonly redactor: Redactor,
  ) {
    const capGbp = Number(
      process.env.ANTHROPIC_SPEND_CAP_GBP_DAILY ?? DEFAULT_DAILY_CAP_GBP,
    );
    this.dailyCapPence = Math.max(0, Math.round(capGbp * 100));
  }

  async classify(input: AnthropicClassifyInput): Promise<AnthropicClassifyResult> {
    const modelId = input.modelId ?? DEFAULT_CLASSIFY_MODEL;
    assertModelAllowed(modelId);
    const prompt = buildClassifyPrompt(input);
    this.redactor.assertSafe(`${prompt.system}\n${prompt.userMessage}`);
    await this.enforceSpendCap();

    const t0 = Date.now();
    const response = await this.sdk.messages.create({
      model: modelId,
      max_tokens: CLASSIFY_MAX_OUTPUT_TOKENS,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.userMessage }],
    });
    const latencyMs = Date.now() - t0;

    const rawText = extractText(response);
    const parsed = parseClassifyJson(rawText);
    const promptTokens = response.usage.input_tokens;
    const completionTokens = response.usage.output_tokens;
    const estimatedCostPence = computeCostPence({
      modelId,
      promptTokens,
      completionTokens,
    });
    this.logger.log(
      `anthropic.classify model=${modelId} tokensIn=${promptTokens} ` +
        `tokensOut=${completionTokens} costPence=${estimatedCostPence} ` +
        `latencyMs=${latencyMs} caseId=${input.caseId}`,
    );

    return {
      modelUsed: modelId,
      sentiment: parsed.sentiment,
      intent: parsed.intent,
      confidence: parsed.confidence,
      rationale: parsed.rationale,
      promptTokens,
      completionTokens,
      estimatedCostPence,
    };
  }

  async draftReply(input: AnthropicDraftInput): Promise<AnthropicDraftResult> {
    const modelId = input.modelId ?? DEFAULT_DRAFT_MODEL;
    assertModelAllowed(modelId);
    const prompt = buildDraftPrompt(input);
    this.redactor.assertSafe(`${prompt.system}\n${prompt.userMessage}`);
    await this.enforceSpendCap();

    const t0 = Date.now();
    const response = await this.sdk.messages.create({
      model: modelId,
      max_tokens: DRAFT_MAX_OUTPUT_TOKENS,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.userMessage }],
    });
    const latencyMs = Date.now() - t0;

    const bodyMarkdown = extractText(response).trim();
    if (!bodyMarkdown) {
      throw new AnthropicEmptyContentError(
        `Anthropic ${modelId} returned empty content (stop_reason=${response.stop_reason ?? 'unknown'})`,
      );
    }
    const promptTokens = response.usage.input_tokens;
    const completionTokens = response.usage.output_tokens;
    const estimatedCostPence = computeCostPence({
      modelId,
      promptTokens,
      completionTokens,
    });
    this.logger.log(
      `anthropic.draftReply model=${modelId} tokensIn=${promptTokens} ` +
        `tokensOut=${completionTokens} costPence=${estimatedCostPence} ` +
        `latencyMs=${latencyMs} caseId=${input.caseId}`,
    );

    return {
      modelUsed: modelId,
      bodyMarkdown,
      promptTokens,
      completionTokens,
      estimatedCostPence,
    };
  }

  private async enforceSpendCap(): Promise<void> {
    const startOfDay = startOfUtcDay(this.clock.now());
    const aggregate = await this.prisma.classificationResult.aggregate({
      where: { createdAt: { gte: startOfDay } },
      _sum: { estimatedCostPence: true },
    });
    const sumPence = aggregate._sum.estimatedCostPence ?? 0;
    if (sumPence >= this.dailyCapPence) {
      throw new AnthropicSpendCapExceeded(
        `Anthropic daily spend cap reached: ${sumPence}p >= ${this.dailyCapPence}p (£${(this.dailyCapPence / 100).toFixed(2)})`,
        sumPence,
        this.dailyCapPence,
      );
    }
  }
}

function extractText(response: AnthropicSdkResponse): string {
  return response.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text ?? '')
    .join('');
}

function parseClassifyJson(raw: string): z.infer<typeof ClassifyJsonSchema> {
  // Tolerate fenced code blocks even though the prompt forbids them.
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new AnthropicJsonParseError(
      `Anthropic classify: response is not valid JSON: ${err instanceof Error ? err.message : err}`,
      raw,
    );
  }
  const validated = ClassifyJsonSchema.safeParse(parsed);
  if (!validated.success) {
    throw new AnthropicJsonParseError(
      `Anthropic classify: response did not match schema (${validated.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')})`,
      raw,
    );
  }
  return validated.data;
}

/** Day boundary for spend-cap aggregation. UTC midnight is good enough
 *  for POC — sub-hour boundary precision doesn't change the cap math. */
function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
}
