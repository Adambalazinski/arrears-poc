import { Injectable } from '@nestjs/common';
import {
  DEFAULT_HARD_TRIGGERS,
  HARD_TRIGGER_SEVERITY,
  type HardTriggerEntry,
  type HardTriggerKind,
} from './hard-triggers';

export interface PreFilterScanInput {
  subject?: string | null;
  bodyText: string;
  bodyHtml?: string | null;
}

export type PreFilterResult =
  | { matched: false; normalisedLength: number }
  | {
      matched: true;
      trigger: HardTriggerKind;
      keyword: string;
      normalisedLength: number;
    };

/**
 * Deterministic hard-trigger pre-filter per docs/ai-decision-spec.md.
 *
 * The Anthropic SDK is never invoked when this returns matched=true. This
 * service is the safety boundary; downstream code (Phase 7.3) is expected
 * to short-circuit on any match before reaching classification.
 *
 * Scope of normalisation, in order:
 *   1. Unicode NFKC (collapses look-alike characters)
 *   2. HTML tag strip (so `<b>I'm struggling</b>` matches)
 *   3. Common HTML-entity decode (&amp; &lt; &gt; &quot; &#39; &apos; &nbsp;)
 *   4. Whitespace collapse to a single space
 *
 * Case is intentionally preserved. Several spec patterns are
 * case-sensitive (DRS, IVA, DWP, MP) to avoid false positives like
 * `addressed` or `champion`; lowercasing would defeat them. The other
 * patterns carry the /i flag and are case-insensitive on their own.
 */
@Injectable()
export class PreFilterService {
  private readonly triggers: readonly HardTriggerEntry[];

  constructor(triggers: readonly HardTriggerEntry[] = DEFAULT_HARD_TRIGGERS) {
    this.triggers = triggers;
  }

  scan(input: PreFilterScanInput): PreFilterResult {
    const text = normaliseText(buildScanCorpus(input));
    let best: { entry: HardTriggerEntry; keyword: string } | null = null;
    for (const entry of this.triggers) {
      const match = entry.pattern.exec(text);
      if (!match) continue;
      if (
        !best ||
        HARD_TRIGGER_SEVERITY[entry.kind] > HARD_TRIGGER_SEVERITY[best.entry.kind]
      ) {
        best = { entry, keyword: match[0] };
      }
    }
    if (!best) {
      return { matched: false, normalisedLength: text.length };
    }
    return {
      matched: true,
      trigger: best.entry.kind,
      keyword: best.keyword,
      normalisedLength: text.length,
    };
  }
}

function buildScanCorpus(input: PreFilterScanInput): string {
  const pieces: string[] = [];
  if (input.subject) pieces.push(input.subject);
  if (input.bodyText) pieces.push(input.bodyText);
  // bodyHtml is included so that messages that only carry HTML content
  // (no plain-text alternative) still get scanned. The normaliser strips
  // the tags before regex matching.
  if (input.bodyHtml) pieces.push(input.bodyHtml);
  return pieces.join('\n');
}

function normaliseText(raw: string): string {
  let text = raw.normalize('NFKC');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}
