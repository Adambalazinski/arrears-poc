import { Injectable } from '@nestjs/common';

/**
 * DI token for the PII redactor. Phase 7.4 introduces this so the
 * AnthropicHttpClient can depend on it; Phase 7.5 lands the real
 * pattern set (phone, postcode, sort code, NI number, etc.) per
 * docs/ai-decision-spec.md.
 */
export const REDACTOR = Symbol('REDACTOR');

export interface RedactedText {
  text: string;
  redactionCount: number;
}

export interface Redactor {
  /** Replace recognised PII patterns with placeholders like `[phone]`. */
  redact(text: string): RedactedText;
  /**
   * Throws RedactionRequiredError if the text still contains anything
   * the redactor recognises. Defence-in-depth — every prompt passes
   * through this before reaching the LLM.
   */
  assertSafe(text: string): void;
}

export class RedactionRequiredError extends Error {
  constructor(
    message: string,
    public readonly matchedPattern?: string,
  ) {
    super(message);
    this.name = 'RedactionRequiredError';
  }
}

/**
 * Phase 7.4 placeholder. `assertSafe` is a no-op so the wrapper can be
 * exercised end-to-end in dev with a real Anthropic key. Phase 7.5
 * replaces this implementation with the real pattern set and tightens
 * `assertSafe` to throw on any unredacted PII.
 *
 * Tests inject their own Redactor mock — in particular the
 * "rejects PII-laden prompts" wrapper test uses an assertSafe that
 * throws, demonstrating the safety boundary independently of the
 * placeholder's looseness.
 */
@Injectable()
export class PassThroughRedactor implements Redactor {
  redact(text: string): RedactedText {
    return { text, redactionCount: 0 };
  }

  assertSafe(): void {
    // Intentionally permissive in 7.4. Phase 7.5 enforces.
  }
}
