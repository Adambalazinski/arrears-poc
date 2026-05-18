import { describe, expect, it } from 'vitest';
import { DefaultRedactor, RedactionRequiredError } from '../redactor';

const redactor = new DefaultRedactor();

describe('DefaultRedactor.redact — pattern coverage', () => {
  it('redacts UK mobile phone numbers', () => {
    const { text, redactionCount } = redactor.redact(
      'Call me on 07777 123456 if you need anything.',
    );
    expect(text).toBe('Call me on [phone] if you need anything.');
    expect(redactionCount).toBe(1);
  });

  it('redacts international phone numbers with +44 prefix', () => {
    const { text } = redactor.redact('My number is +44 7777 123456 thanks.');
    expect(text).toBe('My number is [phone] thanks.');
  });

  it('redacts email addresses', () => {
    const { text, redactionCount } = redactor.redact(
      'Contact me at jane.tenant@example.com or my partner at partner@example.co.uk.',
    );
    expect(text).toBe('Contact me at [email] or my partner at [email].');
    expect(redactionCount).toBe(2);
  });

  it('redacts UK postcodes in common formats', () => {
    const { text } = redactor.redact(
      'My old address was 12 High Street, SW1A 1AA and the new one is M1 1AE.',
    );
    expect(text).toBe(
      'My old address was 12 High Street, [postcode] and the new one is [postcode].',
    );
  });

  it('redacts sort codes', () => {
    const { text } = redactor.redact('Sort code 12-34-56 if you need it.');
    expect(text).toBe('Sort code [sort-code] if you need it.');
  });

  it('redacts 8-digit bank account numbers', () => {
    const { text } = redactor.redact('Account 12345678 at the same branch.');
    expect(text).toBe('Account [account-number] at the same branch.');
  });

  it('redacts NI numbers with and without spaces', () => {
    const { text: a } = redactor.redact('My NI number is AB123456C.');
    expect(a).toBe('My NI number is [ni-number].');
    const { text: b } = redactor.redact('NI: AB 12 34 56 C end.');
    expect(b).toBe('NI: [ni-number] end.');
  });

  it('redacts date-of-birth-ish dates in DMY / MDY / ISO', () => {
    const cases: Array<[string, string]> = [
      ['DOB 01/01/1980 noted.', 'DOB [date] noted.'],
      ['Born 01-01-1980.', 'Born [date].'],
      ['ISO 1980-01-01 recorded.', 'ISO [date] recorded.'],
    ];
    for (const [input, expected] of cases) {
      expect(redactor.redact(input).text).toBe(expected);
    }
  });

  it('does NOT redact long-form dates (kept conservative)', () => {
    const { text, redactionCount } = redactor.redact(
      "I will pay on Friday 22 May 2026 once my salary clears.",
    );
    // "22 May 2026" has no slashes/dashes/4-digit-year-prefix — the
    // conservative date patterns don't fire, and the phone pattern
    // also can't match because "May" is letters.
    expect(text).toContain('22 May 2026');
    expect(redactionCount).toBe(0);
  });
});

describe('DefaultRedactor.redact — false-positive guards', () => {
  it('does not redact GBP amounts like £2,400.00', () => {
    const input =
      'Your balance is £2,400.00 and the most overdue charge is £1,200.00.';
    const { text, redactionCount } = redactor.redact(input);
    expect(text).toBe(input);
    expect(redactionCount).toBe(0);
  });

  it('does not redact human-readable references with dashes', () => {
    const input = 'My reference is RENT-MAY-2026 / tenancy-abc-001.';
    expect(redactor.redact(input).text).toBe(input);
  });

  it('does not redact short digit runs', () => {
    const input = 'I owe 200 pounds for the last 3 weeks (week 19).';
    expect(redactor.redact(input).text).toBe(input);
  });

  it('runs date pattern before phone so ISO dates render as [date], not [phone]', () => {
    const { text } = redactor.redact('Payment cleared 2026-05-10 this morning.');
    expect(text).toBe('Payment cleared [date] this morning.');
  });

  it('redacts only the matched part of a longer reference', () => {
    // Phone pattern requires digit/space/dash + 10+ chars total. The
    // suffix here is short enough not to trigger.
    const input = 'See ticket #4218 for context.';
    expect(redactor.redact(input).text).toBe(input);
  });
});

describe('DefaultRedactor.assertSafe', () => {
  it('passes for empty and PII-free strings', () => {
    expect(() => redactor.assertSafe('')).not.toThrow();
    expect(() =>
      redactor.assertSafe('Could you let me know about the additional fee?'),
    ).not.toThrow();
  });

  it('throws RedactionRequiredError when raw PII is present', () => {
    expect(() => redactor.assertSafe('Call 07777 123456')).toThrow(
      RedactionRequiredError,
    );
    expect(() => redactor.assertSafe('My email is jane@example.com')).toThrow(
      RedactionRequiredError,
    );
    expect(() => redactor.assertSafe('NI: AB123456C')).toThrow(
      RedactionRequiredError,
    );
  });

  it('matchedPattern carries the rule name on the thrown error', () => {
    try {
      redactor.assertSafe('Postcode SW1A 1AA inside');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RedactionRequiredError);
      expect((err as RedactionRequiredError).matchedPattern).toBe('postcode');
    }
  });

  it('passes after redact() — the regression boundary', () => {
    // Concatenate one example per pattern category and confirm:
    //   1. redact replaces them all
    //   2. assertSafe doesn't trip on the redacted output
    const dirty = [
      'Phone 07777 123456.',
      'Email jane@example.com.',
      'Postcode SW1A 1AA.',
      'NI AB123456C.',
      'Sort 12-34-56.',
      'Account 12345678.',
      'DOB 01/01/1980.',
    ].join(' ');
    const { text, redactionCount } = redactor.redact(dirty);
    expect(redactionCount).toBe(7);
    expect(() => redactor.assertSafe(text)).not.toThrow();
    expect(text).not.toContain('07777');
    expect(text).not.toContain('jane@example.com');
    expect(text).not.toContain('SW1A');
    expect(text).not.toContain('AB123456C');
    expect(text).not.toContain('12-34-56');
    expect(text).not.toContain('12345678');
    expect(text).not.toContain('01/01/1980');
  });
});
