import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HardTriggerKind } from '../hard-triggers';
import { PreFilterService } from '../pre-filter.service';

const FIXTURE_DIR = path.resolve(__dirname, '../../../../../fixtures/outlook');

interface ParsedEml {
  fromAddress: string;
  subject: string | null;
  bodyText: string;
}

function parseEml(raw: string): ParsedEml {
  const separatorIdx = raw.indexOf('\n\n');
  const headerBlock = separatorIdx >= 0 ? raw.slice(0, separatorIdx) : raw;
  const body = separatorIdx >= 0 ? raw.slice(separatorIdx + 2) : '';
  const headers = new Map<string, string>();
  for (const line of headerBlock.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers.set(name, value);
  }
  return {
    fromAddress: headers.get('from') ?? '',
    subject: headers.get('subject') ?? null,
    bodyText: body.trim(),
  };
}

function loadFixture(name: string): ParsedEml {
  const file = path.join(FIXTURE_DIR, name);
  return parseEml(readFileSync(file, 'utf8'));
}

interface Case {
  fixture: string;
  expected: HardTriggerKind | null;
}

const CASES: Case[] = [
  { fixture: 'inbound-hardship.eml', expected: 'HARDSHIP_INDICATED' },
  { fixture: 'inbound-mental-health.eml', expected: 'MENTAL_HEALTH_INDICATED' },
  { fixture: 'inbound-breathing-space.eml', expected: 'BREATHING_SPACE' },
  { fixture: 'inbound-third-party.eml', expected: 'THIRD_PARTY_INVOLVED' },
  { fixture: 'inbound-dispute.eml', expected: 'LIABILITY_DISPUTED' },
  { fixture: 'inbound-domestic.eml', expected: 'DOMESTIC_CIRCUMSTANCES' },
  { fixture: 'inbound-routine-promise.eml', expected: null },
  { fixture: 'inbound-payment-confirmed.eml', expected: null },
  { fixture: 'inbound-query.eml', expected: null },
];

const service = new PreFilterService();

describe('PreFilterService — fixtures/outlook/*.eml', () => {
  for (const { fixture, expected } of CASES) {
    const verb = expected === null ? 'does not match' : `matches ${expected}`;
    it(`${fixture} ${verb}`, () => {
      const eml = loadFixture(fixture);
      const result = service.scan({
        subject: eml.subject,
        bodyText: eml.bodyText,
      });
      if (expected === null) {
        expect(result.matched).toBe(false);
      } else {
        expect(result.matched).toBe(true);
        if (result.matched) expect(result.trigger).toBe(expected);
      }
    });
  }

  it('every .eml in the fixtures dir is exercised by a test case (no orphan fixtures)', () => {
    const present = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.eml'));
    const referenced = new Set(CASES.map((c) => c.fixture));
    const orphans = present.filter((f) => !referenced.has(f));
    expect(orphans).toEqual([]);
  });
});
