import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const FIXTURE_DIR = path.resolve(__dirname, '../../../../fixtures/outlook');

export interface ParsedFixtureEml {
  fixtureName: string;
  fromAddress: string;
  subject: string | null;
  bodyText: string;
}

export function listFixtureEmlNames(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.eml'))
    .sort();
}

export function loadFixtureEml(name: string): ParsedFixtureEml {
  if (!name.endsWith('.eml')) {
    throw new Error(`Fixture name must end with .eml: ${name}`);
  }
  const file = path.join(FIXTURE_DIR, name);
  const raw = readFileSync(file, 'utf8');
  return parseEml(name, raw);
}

function parseEml(fixtureName: string, raw: string): ParsedFixtureEml {
  const sep = raw.indexOf('\n\n');
  const headerBlock = sep >= 0 ? raw.slice(0, sep) : raw;
  const body = sep >= 0 ? raw.slice(sep + 2) : '';
  const headers = new Map<string, string>();
  for (const line of headerBlock.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return {
    fixtureName,
    fromAddress: headers.get('from') ?? '',
    subject: headers.get('subject') ?? null,
    bodyText: body.trim(),
  };
}
