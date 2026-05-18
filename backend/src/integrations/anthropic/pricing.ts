/**
 * Per-model pricing for cost estimation. Values are pence (GBP) per
 * million tokens.
 *
 * Anthropic publishes USD pricing; the values here are GBP placeholders
 * assuming roughly £0.80 = $1 — updated manually when prices change.
 * docs/integrations.md §4 covers the verification process for hosted
 * rollout.
 */

export interface ModelPricing {
  modelId: string;
  inputPencePerMillion: number;
  outputPencePerMillion: number;
}

export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  'claude-haiku-4-5': {
    modelId: 'claude-haiku-4-5',
    inputPencePerMillion: 80,
    outputPencePerMillion: 400,
  },
  'claude-sonnet-4-6': {
    modelId: 'claude-sonnet-4-6',
    inputPencePerMillion: 240,
    outputPencePerMillion: 1200,
  },
};

export const MODEL_ALLOWLIST: ReadonlySet<string> = new Set(
  Object.keys(MODEL_PRICING),
);

export class ModelNotAllowedError extends Error {
  constructor(modelId: string) {
    super(
      `Model "${modelId}" is not in the Anthropic allowlist. Add it to MODEL_PRICING in integrations/anthropic/pricing.ts after verifying the rate.`,
    );
    this.name = 'ModelNotAllowedError';
  }
}

export function assertModelAllowed(modelId: string): void {
  if (!MODEL_ALLOWLIST.has(modelId)) {
    throw new ModelNotAllowedError(modelId);
  }
}

export interface ComputeCostArgs {
  modelId: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Cost in pence per docs/integrations.md §4:
 *   costPence = promptTokens * inputPencePerMillion / 1_000_000
 *             + completionTokens * outputPencePerMillion / 1_000_000
 *
 * Rounded UP to the nearest pence because estimatedCostPence is Int in
 * Prisma; over-estimating is the safer error for spend-cap enforcement.
 */
export function computeCostPence({
  modelId,
  promptTokens,
  completionTokens,
}: ComputeCostArgs): number {
  const pricing = MODEL_PRICING[modelId];
  if (!pricing) throw new ModelNotAllowedError(modelId);
  const inputCost = (promptTokens * pricing.inputPencePerMillion) / 1_000_000;
  const outputCost = (completionTokens * pricing.outputPencePerMillion) / 1_000_000;
  return Math.ceil(inputCost + outputCost);
}
