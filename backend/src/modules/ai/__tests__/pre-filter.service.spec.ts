import { describe, expect, it } from 'vitest';
import type { HardTriggerEntry } from '../hard-triggers';
import { PreFilterService } from '../pre-filter.service';

const service = new PreFilterService();

describe('PreFilterService.scan — matching', () => {
  it('matches HARDSHIP_INDICATED on "I lost my job"', () => {
    const r = service.scan({ bodyText: 'I lost my job last month and we are in real trouble.' });
    expect(r.matched).toBe(true);
    if (r.matched) expect(r.trigger).toBe('HARDSHIP_INDICATED');
  });

  it('matches MENTAL_HEALTH_INDICATED on "I\'m really struggling"', () => {
    const r = service.scan({ bodyText: "I'm really struggling at the moment." });
    expect(r.matched).toBe(true);
    if (r.matched) expect(r.trigger).toBe('MENTAL_HEALTH_INDICATED');
  });

  it('matches BREATHING_SPACE on "Debt Respite Scheme"', () => {
    const r = service.scan({
      bodyText: 'I have applied for breathing space under the Debt Respite Scheme.',
    });
    expect(r.matched).toBe(true);
    if (r.matched) expect(r.trigger).toBe('BREATHING_SPACE');
  });

  it('matches THIRD_PARTY_INVOLVED on "solicitor"', () => {
    const r = service.scan({ bodyText: 'My solicitor will be in touch.' });
    expect(r.matched).toBe(true);
    if (r.matched) expect(r.trigger).toBe('THIRD_PARTY_INVOLVED');
  });

  it('matches LIABILITY_DISPUTED on "I don\'t owe"', () => {
    const r = service.scan({ bodyText: "I don't owe this — please check your records." });
    expect(r.matched).toBe(true);
    if (r.matched) expect(r.trigger).toBe('LIABILITY_DISPUTED');
  });

  it('matches DOMESTIC_CIRCUMSTANCES on "passed away"', () => {
    const r = service.scan({ bodyText: 'My partner passed away last week.' });
    expect(r.matched).toBe(true);
    if (r.matched) expect(r.trigger).toBe('DOMESTIC_CIRCUMSTANCES');
  });
});

describe('PreFilterService.scan — severity ordering', () => {
  it('picks MENTAL_HEALTH_INDICATED over HARDSHIP_INDICATED when both match', () => {
    const r = service.scan({
      bodyText:
        "I lost my job and I'm really struggling with my mental health on top of it.",
    });
    expect(r.matched).toBe(true);
    if (r.matched) expect(r.trigger).toBe('MENTAL_HEALTH_INDICATED');
  });

  it('picks BREATHING_SPACE over THIRD_PARTY_INVOLVED on "Citizens Advice"', () => {
    // "citizens advice" appears in both BREATHING_SPACE and THIRD_PARTY_INVOLVED
    // lists; BREATHING_SPACE wins on severity.
    const r = service.scan({ bodyText: 'I am working with Citizens Advice.' });
    expect(r.matched).toBe(true);
    if (r.matched) expect(r.trigger).toBe('BREATHING_SPACE');
  });

  it('picks LIABILITY_DISPUTED last when no higher-severity trigger fires', () => {
    const r = service.scan({ bodyText: 'I never agreed to this charge.' });
    expect(r.matched).toBe(true);
    if (r.matched) expect(r.trigger).toBe('LIABILITY_DISPUTED');
  });
});

describe('PreFilterService.scan — non-matching messages', () => {
  it('returns matched=false for an empty body', () => {
    const r = service.scan({ bodyText: '' });
    expect(r.matched).toBe(false);
  });

  it('returns matched=false for a routine payment promise', () => {
    const r = service.scan({
      bodyText: "Apologies for the delay — I will pay on Friday once my salary clears.",
    });
    expect(r.matched).toBe(false);
  });

  it('returns matched=false for a routine query about a charge', () => {
    const r = service.scan({
      bodyText: 'Could you let me know what the additional fee was for? Thanks.',
    });
    expect(r.matched).toBe(false);
  });
});

describe('PreFilterService.scan — normalisation', () => {
  it('strips HTML tags before matching', () => {
    const r = service.scan({
      bodyText: '',
      bodyHtml: "<p>I'm really <b>struggling</b> at the moment.</p>",
    });
    expect(r.matched).toBe(true);
    if (r.matched) expect(r.trigger).toBe('MENTAL_HEALTH_INDICATED');
  });

  it('decodes common HTML entities before matching', () => {
    const r = service.scan({
      bodyText: 'I&#39;m really struggling &amp; need help.',
    });
    expect(r.matched).toBe(true);
    if (r.matched) expect(r.trigger).toBe('MENTAL_HEALTH_INDICATED');
  });

  it('applies NFKC unicode normalisation so look-alike chars still match', () => {
    // "ﬁ" (U+FB01 ligature) normalises to "fi". Spelling: "ﬁnancial hardship".
    const r = service.scan({ bodyText: 'I am in serious ﬁnancial hardship.' });
    expect(r.matched).toBe(true);
    if (r.matched) expect(r.trigger).toBe('HARDSHIP_INDICATED');
  });

  it('scans the subject as well as the body', () => {
    const r = service.scan({
      subject: 'Breathing space request',
      bodyText: 'Details to follow.',
    });
    expect(r.matched).toBe(true);
    if (r.matched) expect(r.trigger).toBe('BREATHING_SPACE');
  });

  it('preserves case so case-sensitive patterns like /DRS/ still match', () => {
    const r = service.scan({ bodyText: 'My case number under the DRS is 12345.' });
    expect(r.matched).toBe(true);
    if (r.matched) expect(r.trigger).toBe('BREATHING_SPACE');

    // And it does NOT match the lowercased "drs" buried in another word.
    const r2 = service.scan({ bodyText: 'I have not addressed your concerns yet.' });
    expect(r2.matched).toBe(false);
  });
});

describe('PreFilterService — custom trigger list', () => {
  it('respects the constructor override', () => {
    const single: HardTriggerEntry[] = [
      { kind: 'LIABILITY_DISPUTED', pattern: /\bUNIQUE_TOKEN\b/i },
    ];
    const custom = new PreFilterService(single);
    expect(custom.scan({ bodyText: 'normal body' }).matched).toBe(false);
    expect(custom.scan({ bodyText: 'has UNIQUE_TOKEN here' }).matched).toBe(true);
  });
});
