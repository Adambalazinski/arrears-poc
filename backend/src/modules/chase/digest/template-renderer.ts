import Mustache from 'mustache';

export interface TenantContext {
  firstName: string;
  lastName: string;
}

export interface PropertyContext {
  address: string;
  name: string;
}

export interface ChargeLineContext {
  referenceId: string;
  dueDateFormatted: string;
  grossAmountFormatted: string;
  remainAmountFormatted: string;
  workingDaysOverdue: number;
}

export interface CaseContext {
  balanceFormatted: string;
  balancePence: number;
  chargeCount: number;
  openedDate: string;
}

export interface AgencyContext {
  name: string;
  replyEmail: string;
}

export interface TemplateContext {
  tenant: TenantContext;
  /** Populated when a guarantor exists on the tenancy. Empty strings
   * otherwise — guarantor-flavoured templates only fire when the chase
   * tick emits a GUARANTOR-track entry, which requires a guarantor with
   * a primary email. */
  guarantor: TenantContext;
  property: PropertyContext;
  case: CaseContext;
  charges: ChargeLineContext[];
  mostOverdueCharge: ChargeLineContext;
  agency: AgencyContext;
}

export class TemplateRenderError extends Error {
  constructor(message: string, public readonly missing: string[]) {
    super(message);
    this.name = 'TemplateRenderError';
  }
}

/**
 * Mustache renderer wrapper. Refuses to silently emit blanks for missing
 * variables — `Mustache.render` returns "" for unknown lookups by default,
 * which masks template bugs. We pre-walk the template and assert every
 * non-section token resolves to a non-empty path on the context.
 *
 * Step 5.2 ships the basic happy path; step 5.3 will seed BRD-accurate
 * defaults and tighten variable coverage (e.g. {{#charges}} loop variables).
 */
export function renderTemplate(template: string, context: TemplateContext): string {
  Mustache.parse(template); // throws on syntactically invalid templates
  const missing = findMissingVariables(template, context);
  if (missing.length > 0) {
    throw new TemplateRenderError(
      `Template references missing variables: ${missing.join(', ')}`,
      missing,
    );
  }
  return Mustache.render(template, context);
}

/**
 * Walks the parsed Mustache token tree. Tokens are arrays where index 0 is
 * the token type ('text', 'name', '#', '^', '/', etc.).
 * For simple {{var}} tokens (type='name') we resolve the dotted path
 * against the context and require a defined value.
 */
function findMissingVariables(template: string, context: TemplateContext): string[] {
  const tokens = Mustache.parse(template) as MustacheToken[];
  const missing: string[] = [];
  walk(tokens, [], context as unknown as Record<string, unknown>);
  return missing;

  function walk(
    list: MustacheToken[],
    contextStack: string[],
    root: Record<string, unknown>,
  ): void {
    for (const token of list) {
      const [type, key, , , childTokens] = token;
      if (type === 'name' || type === '&') {
        if (!resolves(root, key, contextStack)) {
          missing.push([...contextStack, key].filter(Boolean).join('.'));
        }
      } else if (type === '#' || type === '^') {
        // Section / inverted section. Recurse into children with the key
        // pushed onto the context stack — for arrays, children are
        // evaluated in the array-item scope so we just verify the
        // section value exists. For object scopes, same.
        if (!resolves(root, key, contextStack)) {
          missing.push([...contextStack, key].filter(Boolean).join('.'));
        }
        if (Array.isArray(childTokens)) {
          walk(childTokens as MustacheToken[], [...contextStack, key], root);
        }
      }
    }
  }
}

function resolves(
  root: Record<string, unknown>,
  key: string,
  contextStack: string[],
): boolean {
  if (key === '.') return true; // current item in an iteration
  const path = key.split('.');
  // Try contextStack scopes from innermost to outermost, then root.
  for (let i = contextStack.length; i >= 0; i--) {
    const scopePath = contextStack.slice(0, i);
    const value = lookupPath(root, [...scopePath, ...path]);
    if (value !== undefined) return true;
  }
  return false;
}

function lookupPath(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const segment of path) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      // Inside an iteration we'd evaluate per-item — for the static
      // pre-flight we just check the first item's shape.
      if (cur.length === 0) return undefined;
      cur = (cur[0] as Record<string, unknown>)[segment];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return cur;
}

type MustacheToken = [
  type: string,
  key: string,
  start: number,
  end: number,
  children?: unknown,
];
