import { describe, expect, it } from 'vitest';
import { LwcaPagedInvoicesSchema } from '../lwca-invoice.types';
import { normaliseStagePage, normaliseStageRow } from '../lwca-stage-shape';

const STAGE_ROW = {
  id: 'inv-1',
  organisationId: 'depositltd',
  referenceId: 'R-1',
  grossAmount: 100000,
  remainAmount: 100000,
  dueDate: '2026-04-01',
  invoiceDate: '2026-03-15',
  status: 'UNPAID',
  paymentCycleType: 'MONTHLY',
  // Stage divergence: top-level tenancyId is always null; real id sits at tenancy.id.
  tenancyId: null,
  tenancy: { id: 'tn-abc', reference: 'C-Tenant-2026', balance: null },
  type: 'OUTBOUND',
  payeeType: 'LANDLORD',
};

const STAGE_PAGE = {
  returnList: [STAGE_ROW],
  page: 1,
  totalItems: 1,
  totalPages: 1,
};

describe('normaliseStagePage', () => {
  it('remaps the stage envelope to the canonical Spring-Page shape', () => {
    const out = normaliseStagePage(STAGE_PAGE) as Record<string, unknown>;
    expect(out.content).toBeDefined();
    expect(out.number).toBe(1);
    expect(out.totalElements).toBe(1);
    expect(out.totalPages).toBe(1);
    // The original keys aren't copied through — only the canonical ones.
    expect(out.returnList).toBeUndefined();
    expect(out.totalItems).toBeUndefined();
  });

  it('is a no-op when the body already has the canonical `content` key', () => {
    const canonical = { content: [STAGE_ROW], totalElements: 1, totalPages: 1, number: 0 };
    expect(normaliseStagePage(canonical)).toBe(canonical);
  });

  it('produces a body that the canonical Zod schema parses', () => {
    const normalised = normaliseStagePage(STAGE_PAGE);
    const parsed = LwcaPagedInvoicesSchema.parse(normalised);
    expect(parsed.content).toHaveLength(1);
    expect(parsed.content[0]!.tenancyId).toBe('tn-abc');
  });

  it('returns non-object inputs unchanged', () => {
    expect(normaliseStagePage(null)).toBeNull();
    expect(normaliseStagePage('hello')).toBe('hello');
    expect(normaliseStagePage([1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe('normaliseStageRow', () => {
  it('lifts tenancy.id into a null/missing top-level tenancyId', () => {
    const out = normaliseStageRow(STAGE_ROW) as Record<string, unknown>;
    expect(out.tenancyId).toBe('tn-abc');
  });

  it('does not overwrite a non-null top-level tenancyId', () => {
    const row = { ...STAGE_ROW, tenancyId: 'already-set' };
    const out = normaliseStageRow(row) as Record<string, unknown>;
    expect(out.tenancyId).toBe('already-set');
  });

  it('leaves tenancyId null when tenancy.id is also missing/null', () => {
    const row = { ...STAGE_ROW, tenancy: { id: null, reference: null, balance: null } };
    const out = normaliseStageRow(row) as Record<string, unknown>;
    expect(out.tenancyId).toBeNull();
  });

  it('returns non-object inputs unchanged', () => {
    expect(normaliseStageRow(null)).toBeNull();
    expect(normaliseStageRow(42)).toBe(42);
  });
});
