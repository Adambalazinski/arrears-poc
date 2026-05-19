/**
 * Adapters that bring LWCA stage's HTTP response shapes back to the
 * canonical envelope the rest of the codebase expects.
 *
 * Stage divergences (May 2026):
 *   - Paged response is `{ returnList, page, totalItems, totalPages }`
 *     instead of Spring Data's `{ content, number, totalElements,
 *     totalPages }` that the fixture uses.
 *   - Inside each row, `tenancyId` is always null. The real tenancy id
 *     lives at `tenancy.id` (nested object `{ id, reference, balance }`).
 *
 * Kept as pure functions so they can be exercised in isolation.
 */

export function normaliseStagePage(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const r = body as Record<string, unknown>;
  if ('returnList' in r && !('content' in r)) {
    const items = Array.isArray(r.returnList)
      ? r.returnList.map(normaliseStageRow)
      : r.returnList;
    return {
      content: items,
      number: r.page,
      totalElements: r.totalItems,
      totalPages: r.totalPages,
    };
  }
  return body;
}

export function normaliseStageRow(row: unknown): unknown {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const r = row as Record<string, unknown>;
  const next: Record<string, unknown> = { ...r };
  if (
    (next.tenancyId == null || next.tenancyId === '') &&
    typeof next.tenancy === 'object' &&
    next.tenancy !== null
  ) {
    const t = next.tenancy as Record<string, unknown>;
    if (typeof t.id === 'string') next.tenancyId = t.id;
  }
  return next;
}
