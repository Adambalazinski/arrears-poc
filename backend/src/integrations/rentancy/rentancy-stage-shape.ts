/**
 * Adapters that bring Rentancy stage's HTTP response shapes back to the
 * canonical envelope the rest of the codebase expects.
 *
 * Stage divergences (May 2026):
 *   - Tenancy.tenants is an array of `{ tenantId, primary }` objects, not
 *     plain id strings. guarantorIds / guarantors follow the same pattern.
 *   - Contact response uses `firstName` / `lastName` (camelCase) instead
 *     of the fixture's `fname` / `sname`.
 *
 * Kept as pure functions so they can be exercised in isolation.
 */

export function normaliseStageTenancy(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const r = body as Record<string, unknown>;
  const next: Record<string, unknown> = { ...r };
  for (const key of ['tenants', 'guarantorIds', 'guarantors']) {
    const v = next[key];
    if (Array.isArray(v)) {
      next[key] = v
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object') {
            const o = item as Record<string, unknown>;
            const candidate = o.id ?? o.tenantId ?? o.guarantorId ?? o.contactId;
            if (typeof candidate === 'string') return candidate;
          }
          return null;
        })
        .filter((x): x is string => typeof x === 'string');
    }
  }
  // Stage uses `rent` for the rent amount; canonical/fixture use `agreedPrice`.
  if (next.agreedPrice == null && (typeof next.rent === 'number' || typeof next.rent === 'string')) {
    next.agreedPrice = next.rent;
  }
  return next;
}

export function normaliseStageContact(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const r = body as Record<string, unknown>;
  const next: Record<string, unknown> = { ...r };
  if (next.fname == null && typeof next.firstName === 'string') next.fname = next.firstName;
  if (next.sname == null && typeof next.lastName === 'string') next.sname = next.lastName;
  return next;
}
