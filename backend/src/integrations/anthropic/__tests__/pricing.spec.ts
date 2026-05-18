import { describe, expect, it } from 'vitest';
import {
  assertModelAllowed,
  computeCostPence,
  MODEL_ALLOWLIST,
  ModelNotAllowedError,
} from '../pricing';

describe('pricing.computeCostPence', () => {
  it('Haiku 4.5: 1M input + 1M output rounds to 480p (80 + 400)', () => {
    const pence = computeCostPence({
      modelId: 'claude-haiku-4-5',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(pence).toBe(480);
  });

  it('Sonnet 4.6: 1M input + 1M output rounds to 1440p (240 + 1200)', () => {
    const pence = computeCostPence({
      modelId: 'claude-sonnet-4-6',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(pence).toBe(1440);
  });

  it('Haiku: small call rounds up to 1p with Math.ceil', () => {
    // 500 input tokens * 80p/M + 100 output tokens * 400p/M
    //   = 0.04p + 0.04p = 0.08p → ceil → 1p
    expect(
      computeCostPence({
        modelId: 'claude-haiku-4-5',
        promptTokens: 500,
        completionTokens: 100,
      }),
    ).toBe(1);
  });

  it('Sonnet: typical draft call (~800 in / 200 out) ≈ 1p', () => {
    // 800 * 240/M + 200 * 1200/M = 0.192p + 0.24p = 0.432p → ceil → 1p
    expect(
      computeCostPence({
        modelId: 'claude-sonnet-4-6',
        promptTokens: 800,
        completionTokens: 200,
      }),
    ).toBe(1);
  });

  it('zero tokens yields zero pence', () => {
    expect(
      computeCostPence({
        modelId: 'claude-haiku-4-5',
        promptTokens: 0,
        completionTokens: 0,
      }),
    ).toBe(0);
  });

  it('unknown model throws ModelNotAllowedError', () => {
    expect(() =>
      computeCostPence({
        modelId: 'claude-mystery-9',
        promptTokens: 100,
        completionTokens: 100,
      }),
    ).toThrow(ModelNotAllowedError);
  });
});

describe('pricing.assertModelAllowed', () => {
  it('allows the two configured models', () => {
    expect(() => assertModelAllowed('claude-haiku-4-5')).not.toThrow();
    expect(() => assertModelAllowed('claude-sonnet-4-6')).not.toThrow();
  });

  it('rejects anything else', () => {
    expect(() => assertModelAllowed('claude-opus-4-7')).toThrow(ModelNotAllowedError);
    expect(() => assertModelAllowed('')).toThrow(ModelNotAllowedError);
  });

  it('MODEL_ALLOWLIST contains the documented models', () => {
    expect(MODEL_ALLOWLIST.has('claude-haiku-4-5')).toBe(true);
    expect(MODEL_ALLOWLIST.has('claude-sonnet-4-6')).toBe(true);
  });
});
