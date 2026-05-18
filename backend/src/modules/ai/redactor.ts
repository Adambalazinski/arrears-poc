import { Injectable } from '@nestjs/common';

/**
 * DI token for the PII redactor.
 *
 * Phase 7.5 lands the real pattern set. The default `DefaultRedactor`
 * implementation strips structured UK-flavoured PII before any text
 * leaves for an LLM; `assertSafe` re-runs the same checks as
 * defence-in-depth so a buggy `redact` call surfaces at the wrapper
 * boundary rather than silently leaking PII to Anthropic.
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

interface PatternRule {
  name: string;
  pattern: RegExp;
  placeholder: string;
}

/**
 * Patterns intentionally ordered so more-specific rules claim digit
 * runs before the broad phone regex. ISO and DMY dates would
 * otherwise be swallowed by the phone pattern (10+ chars of
 * digit/space/dash).
 *
 * Each pattern is `g`-flagged for `replaceAll`. The case-sensitivity
 * mostly doesn't matter (the spec normalises case elsewhere) but
 * postcode and NI patterns are case-insensitive so users typing in
 * lowercase still get caught.
 */
const PATTERNS: readonly PatternRule[] = [
  // Date-of-birth-ish: DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD. "Conservative"
  // per the spec — we don't try to recognise long-form dates like
  // "1 May 2026" since those almost never carry DOB context in a
  // tenant message.
  {
    name: 'date',
    pattern: /\b\d{1,2}\/\d{1,2}\/(?:19|20)\d{2}\b/g,
    placeholder: '[date]',
  },
  {
    name: 'date',
    pattern: /\b\d{1,2}-\d{1,2}-(?:19|20)\d{2}\b/g,
    placeholder: '[date]',
  },
  {
    name: 'date',
    pattern: /\b(?:19|20)\d{2}-\d{1,2}-\d{1,2}\b/g,
    placeholder: '[date]',
  },
  // UK postcodes: 1–2 letters, 1 digit, 0–1 letter-or-digit, optional
  // space, then 1 digit + 2 letters. Covers SW1A 1AA, M1 1AE, B33 8TH,
  // CR2 6XH, etc.
  {
    name: 'postcode',
    pattern: /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/gi,
    placeholder: '[postcode]',
  },
  // UK NI number: 2 letters + 6 digits + 1 letter, with optional
  // spaces between the digit pairs. We keep the letter classes loose
  // (the spec calls this "9-digit-with-letter NI number pattern" — a
  // simplification).
  {
    name: 'ni-number',
    pattern: /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-Z]\b/gi,
    placeholder: '[ni-number]',
  },
  // Sort code per the spec.
  {
    name: 'sort-code',
    pattern: /\b\d{2}-\d{2}-\d{2}\b/g,
    placeholder: '[sort-code]',
  },
  // Bank account number per the spec — any 8-digit run on a word
  // boundary. Aggressive enough to catch invoice IDs that look like
  // account numbers; that's an acceptable false-positive for POC.
  {
    name: 'account-number',
    pattern: /\b\d{8}\b/g,
    placeholder: '[account-number]',
  },
  // Email addresses. The spec mentions "other than the sender's", but
  // the prompt template doesn't carry the sender's email — only their
  // first name — so we strip every match. Lower bar for false
  // negatives outweighs the lost context.
  {
    name: 'email',
    pattern: /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g,
    placeholder: '[email]',
  },
  // Phone numbers per the spec. Runs last so dates and account
  // numbers (which would also match the loose phone class) have
  // already been replaced. `\b` is replaced with word-char lookarounds
  // so `+44 …` is captured whole — `\b` doesn't fire between a string
  // boundary and a leading `+`.
  {
    name: 'phone',
    pattern: /(?<!\w)\+?\d[\d\s-]{8,}\d(?!\w)/g,
    placeholder: '[phone]',
  },
];

/**
 * Stateless. The regex objects are shared across calls; `replaceAll`
 * with a `g`-flagged RegExp doesn't mutate state (lastIndex is reset
 * each call) and `RegExp#test` is only used in non-stateful contexts
 * below — fresh RegExp clones are not required.
 */
@Injectable()
export class DefaultRedactor implements Redactor {
  redact(text: string): RedactedText {
    let working = text;
    let count = 0;
    for (const rule of PATTERNS) {
      working = working.replace(rule.pattern, () => {
        count++;
        return rule.placeholder;
      });
    }
    return { text: working, redactionCount: count };
  }

  assertSafe(text: string): void {
    for (const rule of PATTERNS) {
      // Build a fresh non-stateful matcher so the global flag on the
      // shared instance doesn't carry lastIndex into the next call.
      const matcher = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', ''));
      const match = matcher.exec(text);
      if (match) {
        throw new RedactionRequiredError(
          `Unredacted ${rule.name} pattern present in prompt (matched "${match[0]}"). Call redact() first.`,
          rule.name,
        );
      }
    }
  }
}

/**
 * Kept around because tests occasionally want an explicit no-op. The
 * AiModule provides `DefaultRedactor` from Phase 7.5 onward — code that
 * needs a permissive redactor should construct this directly.
 */
@Injectable()
export class PassThroughRedactor implements Redactor {
  redact(text: string): RedactedText {
    return { text, redactionCount: 0 };
  }

  assertSafe(): void {
    // No-op. Use only when you need to bypass redaction in a test.
  }
}
