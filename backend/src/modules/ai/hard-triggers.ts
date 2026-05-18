/**
 * Deterministic hard-trigger regex list from docs/ai-decision-spec.md.
 *
 * Six categories, ordered by severity (highest first). A match in any
 * category short-circuits the inbound pipeline (no Anthropic invocation).
 *
 * The spec's "case-sensitive" patterns (DRS / IVA / DWP / MP) are kept as
 * written: lowercasing would defeat their false-positive guard. The
 * normaliser in pre-filter.service.ts therefore preserves case.
 */

export type HardTriggerKind =
  | 'MENTAL_HEALTH_INDICATED'
  | 'BREATHING_SPACE'
  | 'DOMESTIC_CIRCUMSTANCES'
  | 'HARDSHIP_INDICATED'
  | 'THIRD_PARTY_INVOLVED'
  | 'LIABILITY_DISPUTED';

/**
 * Higher number = more severe. When more than one category matches, the
 * pre-filter returns the most-severe kind (with the keyword that hit
 * inside that category).
 */
export const HARD_TRIGGER_SEVERITY: Readonly<Record<HardTriggerKind, number>> = {
  MENTAL_HEALTH_INDICATED: 6,
  BREATHING_SPACE: 5,
  DOMESTIC_CIRCUMSTANCES: 4,
  HARDSHIP_INDICATED: 3,
  THIRD_PARTY_INVOLVED: 2,
  LIABILITY_DISPUTED: 1,
};

export interface HardTriggerEntry {
  kind: HardTriggerKind;
  pattern: RegExp;
}

export const DEFAULT_HARD_TRIGGERS: readonly HardTriggerEntry[] = [
  // ---------- HARDSHIP_INDICATED ----------
  { kind: 'HARDSHIP_INDICATED', pattern: /\bi('?| have)\s+(lost|losing)\s+(my|the)\s+job\b/i },
  { kind: 'HARDSHIP_INDICATED', pattern: /\bmade redundant\b/i },
  { kind: 'HARDSHIP_INDICATED', pattern: /\bcan'?t\s+afford\s+to\s+pay\b/i },
  { kind: 'HARDSHIP_INDICATED', pattern: /\bno\s+money\s+to\s+(pay|live)\b/i },
  { kind: 'HARDSHIP_INDICATED', pattern: /\bcan'?t\s+make\s+(rent|the\s+payment|the\s+rent)\b/i },
  { kind: 'HARDSHIP_INDICATED', pattern: /\bbenefits?\s+(stopped|sanctioned|delayed)\b/i },
  { kind: 'HARDSHIP_INDICATED', pattern: /\bfood\s+bank\b/i },
  { kind: 'HARDSHIP_INDICATED', pattern: /\bgone\s+hungry\b/i },
  { kind: 'HARDSHIP_INDICATED', pattern: /\bfinancial\s+hardship\b/i },
  { kind: 'HARDSHIP_INDICATED', pattern: /\bevicted\b/i },
  { kind: 'HARDSHIP_INDICATED', pattern: /\bhomeless\b/i },

  // ---------- MENTAL_HEALTH_INDICATED ----------
  { kind: 'MENTAL_HEALTH_INDICATED', pattern: /\bi'?m\s+(really\s+)?struggling\b/i },
  { kind: 'MENTAL_HEALTH_INDICATED', pattern: /\bnot\s+coping\b/i },
  { kind: 'MENTAL_HEALTH_INDICATED', pattern: /\bcan'?t\s+cope\b/i },
  { kind: 'MENTAL_HEALTH_INDICATED', pattern: /\bmental\s+health\b/i },
  { kind: 'MENTAL_HEALTH_INDICATED', pattern: /\bdepress(ed|ion)\b/i },
  { kind: 'MENTAL_HEALTH_INDICATED', pattern: /\banxiety\b/i },
  { kind: 'MENTAL_HEALTH_INDICATED', pattern: /\bsuicid/i }, // suicide / suicidal — sensitive
  { kind: 'MENTAL_HEALTH_INDICATED', pattern: /\bself[\s-]?harm\b/i },
  { kind: 'MENTAL_HEALTH_INDICATED', pattern: /\bbreak\s?down\b/i },
  { kind: 'MENTAL_HEALTH_INDICATED', pattern: /\bnervous\s+break/i },
  { kind: 'MENTAL_HEALTH_INDICATED', pattern: /\bovermedicated\b/i },
  { kind: 'MENTAL_HEALTH_INDICATED', pattern: /\bin\s+hospital\b/i },
  { kind: 'MENTAL_HEALTH_INDICATED', pattern: /\bsection(ed)?\b/i },

  // ---------- BREATHING_SPACE ----------
  { kind: 'BREATHING_SPACE', pattern: /\bbreathing\s+space\b/i },
  { kind: 'BREATHING_SPACE', pattern: /\bdebt\s+respite\b/i },
  { kind: 'BREATHING_SPACE', pattern: /\bdebt\s+(advice|adviser|charity|management)\b/i },
  { kind: 'BREATHING_SPACE', pattern: /\bcitizens?\s+advice\b/i },
  { kind: 'BREATHING_SPACE', pattern: /\bstep\s?change\b/i },
  { kind: 'BREATHING_SPACE', pattern: /\bnational\s+debtline\b/i },
  { kind: 'BREATHING_SPACE', pattern: /\bpaylink\b/i },
  { kind: 'BREATHING_SPACE', pattern: /\bdebt\s+respite\s+scheme\b/i },
  { kind: 'BREATHING_SPACE', pattern: /\bDRS\b/ }, // case-sensitive intentional
  { kind: 'BREATHING_SPACE', pattern: /\binsolvency\b/i },
  { kind: 'BREATHING_SPACE', pattern: /\bIVA\b/ }, // case-sensitive intentional
  { kind: 'BREATHING_SPACE', pattern: /\bdebt\s+management\s+plan\b/i },

  // ---------- THIRD_PARTY_INVOLVED ----------
  { kind: 'THIRD_PARTY_INVOLVED', pattern: /\bsolicitor\b/i },
  { kind: 'THIRD_PARTY_INVOLVED', pattern: /\blawyer\b/i },
  { kind: 'THIRD_PARTY_INVOLVED', pattern: /\blegal\s+(advice|representative|aid)\b/i },
  { kind: 'THIRD_PARTY_INVOLVED', pattern: /\bcouncil\b/i },
  { kind: 'THIRD_PARTY_INVOLVED', pattern: /\bhousing\s+officer\b/i },
  { kind: 'THIRD_PARTY_INVOLVED', pattern: /\buniversal\s+credit\b/i },
  { kind: 'THIRD_PARTY_INVOLVED', pattern: /\bhousing\s+benefit\b/i },
  { kind: 'THIRD_PARTY_INVOLVED', pattern: /\bDWP\b/ }, // case-sensitive intentional
  { kind: 'THIRD_PARTY_INVOLVED', pattern: /\bcitizens?\s+advice\b/i },
  { kind: 'THIRD_PARTY_INVOLVED', pattern: /\bshelter\b/i },
  { kind: 'THIRD_PARTY_INVOLVED', pattern: /\bombudsman\b/i },
  { kind: 'THIRD_PARTY_INVOLVED', pattern: /\btribunal\b/i },
  { kind: 'THIRD_PARTY_INVOLVED', pattern: /\bMP\b/ }, // case-sensitive intentional
  { kind: 'THIRD_PARTY_INVOLVED', pattern: /\bcourt\b/i },

  // ---------- LIABILITY_DISPUTED ----------
  { kind: 'LIABILITY_DISPUTED', pattern: /\bi\s+don'?t\s+owe\b/i },
  { kind: 'LIABILITY_DISPUTED', pattern: /\bthis\s+isn'?t\s+my\s+debt\b/i },
  { kind: 'LIABILITY_DISPUTED', pattern: /\bnot\s+my\s+(rent|debt|charge|tenancy)\b/i },
  { kind: 'LIABILITY_DISPUTED', pattern: /\bnever\s+agreed\b/i },
  { kind: 'LIABILITY_DISPUTED', pattern: /\bdispute\s+(this|the)\s+(charge|amount|debt)\b/i },
  { kind: 'LIABILITY_DISPUTED', pattern: /\bincorrect\s+(amount|charge|balance)\b/i },
  { kind: 'LIABILITY_DISPUTED', pattern: /\balready\s+paid\b/i },
  { kind: 'LIABILITY_DISPUTED', pattern: /\bidentity\s+theft\b/i },

  // ---------- DOMESTIC_CIRCUMSTANCES ----------
  { kind: 'DOMESTIC_CIRCUMSTANCES', pattern: /\bbereave/i }, // bereaved / bereavement
  { kind: 'DOMESTIC_CIRCUMSTANCES', pattern: /\bpassed\s+away\b/i },
  { kind: 'DOMESTIC_CIRCUMSTANCES', pattern: /\bdied\b/i },
  { kind: 'DOMESTIC_CIRCUMSTANCES', pattern: /\bfuneral\b/i },
  { kind: 'DOMESTIC_CIRCUMSTANCES', pattern: /\bdivorce\b/i },
  { kind: 'DOMESTIC_CIRCUMSTANCES', pattern: /\bseparat(ed|ion)\b/i },
  { kind: 'DOMESTIC_CIRCUMSTANCES', pattern: /\bdomestic\s+(abuse|violence)\b/i },
  { kind: 'DOMESTIC_CIRCUMSTANCES', pattern: /\brefuge\b/i },
  { kind: 'DOMESTIC_CIRCUMSTANCES', pattern: /\brestraining\s+order\b/i },
  { kind: 'DOMESTIC_CIRCUMSTANCES', pattern: /\bfled\b/i },
];
